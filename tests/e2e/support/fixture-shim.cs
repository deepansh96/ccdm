// Windows front for an E2E fixture tool. The harness compiles this file once per
// content hash and places a copy as <tool>.exe next to <tool>.shim, so a tool can
// be found through PATH even though Windows cannot run a shebang script.
//
// <tool>.shim is UTF-8, one item per line:
//   line 1      absolute path of the program to run, or ":noop" to exit 0 at once
//   other lines arguments that come before the caller's own
//
// The caller's arguments are copied from the raw command line, never parsed and
// quoted again, so the child parses exactly what the caller wrote.
//
// The child and everything under it run in a job object owned by this process.
// If this process is killed, the kernel closes the job and kills the tree. If the
// child exits on its own, the job is left running without the kill-on-close limit,
// so a detached grandchild (a fixture tmux session) outlives the tool, as it would
// on POSIX; a workspace's own job (below) still ends it at teardown.
//
// Ctrl+Break, or the workspace's stop event, is forwarded to the child's process
// group. The child gets a grace period, then whatever is left of the tree is killed.
//
// A workspace's fixtures dir holds .job with one line, a kernel object name:
//   <name>        a job the harness holds open; every child also joins it
//   <name>-stop   an event the harness sets at teardown
// and .live, which holds a delete-on-close file for each launcher still running.
// A launcher with no .job beside it (a copy under test) simply has neither.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class FixtureShim
{
    private const int StdInput = -10;
    private const int StdOutput = -11;
    private const int StdError = -12;
    private const uint HandleFlagInherit = 1;
    private const uint StartfUseStdHandles = 0x100;
    private const uint CreateSuspended = 0x4;
    private const uint CreateNewProcessGroup = 0x200;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private static readonly IntPtr AttributeHandleList = new IntPtr(0x00020002);
    private const uint Infinite = 0xFFFFFFFF;
    private const uint CtrlBreakEvent = 1;
    private const uint JobObjectAssignProcess = 0x0001;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;
    private const uint GraceMilliseconds = 2000;
    private const uint ForcedExitCode = 1;

    private const int Running = 0;
    private const int Finished = 1;
    private const int Stopping = 2;

    private static int state = Running;
    private static IntPtr treeJob;
    private static ProcessInformation child;
    private static bool sharesConsole;
    private static ConsoleCtrlHandler ctrlHandler;
    private static FileStream liveFile;

    private delegate bool ConsoleCtrlHandler(uint ctrlType);

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetCommandLineW();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetModuleFileNameW(IntPtr module, StringBuilder name, uint size);

    [DllImport("kernel32.dll")]
    private static extern uint GetConsoleCP();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll")]
    private static extern void ExitProcess(uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int which);

    [DllImport("kernel32.dll")]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfoEx startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    private static int Main()
    {
        string shim = Path.ChangeExtension(OwnPath(), ".shim");
        string[] lines;
        try
        {
            lines = File.ReadAllLines(shim, new UTF8Encoding(false));
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("fixture launcher: cannot read " + shim + ": " + error.Message);
            return 127;
        }
        if (lines.Length == 0 || lines[0].Length == 0)
        {
            Console.Error.WriteLine("fixture launcher: " + shim + " names no program");
            return 127;
        }
        if (lines[0] == ":noop") return 0;

        var commandLine = new StringBuilder();
        foreach (string line in lines)
        {
            if (line.Length == 0) continue;
            if (commandLine.Length > 0) commandLine.Append(' ');
            AppendQuoted(commandLine, line);
        }
        string callerArguments = ArgumentsOf(Marshal.PtrToStringUni(GetCommandLineW()));
        if (callerArguments.Length > 0) commandLine.Append(' ').Append(callerArguments);

        var startup = new StartupInfoEx();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        startup.StartupInfo.dwFlags = StartfUseStdHandles;
        startup.StartupInfo.hStdInput = Inheritable(GetStdHandle(StdInput));
        startup.StartupInfo.hStdOutput = Inheritable(GetStdHandle(StdOutput));
        startup.StartupInfo.hStdError = Inheritable(GetStdHandle(StdError));
        bool inherit = LimitInheritanceToStdio(ref startup);

        // Without a console of ours the child gets its own hidden one (a console child
        // would otherwise open a window). AllocConsole here could show one on screen.
        sharesConsole = GetConsoleCP() != 0;
        uint flags = (sharesConsole ? 0 : CreateNoWindow) | ExtendedStartupInfoPresent | CreateSuspended | CreateNewProcessGroup;
        if (!CreateProcessW(lines[0], commandLine, IntPtr.Zero, IntPtr.Zero, inherit, flags, IntPtr.Zero, null,
                ref startup, out child))
        {
            Console.Error.WriteLine("fixture launcher: cannot start " + lines[0] + ": error " + Marshal.GetLastWin32Error());
            return 126;
        }

        string directory = Path.GetDirectoryName(shim);
        string workspaceJob = WorkspaceJobName(directory);
        // The outer job first: the tree job then nests inside it (Windows 8 and later).
        if (workspaceJob != null) JoinWorkspaceJob(workspaceJob);
        treeJob = NewTreeJob();
        if (!AssignProcessToJobObject(treeJob, child.hProcess))
        {
            Console.Error.WriteLine("fixture launcher: cannot join the tree job: error " + Marshal.GetLastWin32Error());
        }
        ResumeThread(child.hThread);

        if (workspaceJob != null) MarkLive(directory);
        ctrlHandler = OnConsoleCtrl;
        SetConsoleCtrlHandler(ctrlHandler, true);
        if (workspaceJob != null) WatchStopEvent(workspaceJob + "-stop");

        WaitForSingleObject(child.hProcess, Infinite);
        // A stop already under way owns the exit.
        if (Interlocked.CompareExchange(ref state, Finished, Running) != Running) Thread.Sleep(Timeout.Infinite);
        ClearKillOnClose();
        uint exitCode;
        GetExitCodeProcess(child.hProcess, out exitCode);
        return unchecked((int)exitCode);
    }

    private static bool OnConsoleCtrl(uint ctrlType)
    {
        if (ctrlType != CtrlBreakEvent) return false;
        Stop();
        return true;
    }

    private static void Stop()
    {
        if (Interlocked.CompareExchange(ref state, Stopping, Running) != Running) return;
        BreakChild();
        uint exitCode = ForcedExitCode;
        if (WaitForSingleObject(child.hProcess, GraceMilliseconds) == 0) GetExitCodeProcess(child.hProcess, out exitCode);
        TerminateJobObject(treeJob, ForcedExitCode);
        ExitProcess(exitCode);
    }

    private static void BreakChild()
    {
        if (!sharesConsole && !AttachConsole(child.dwProcessId)) return;
        GenerateConsoleCtrlEvent(CtrlBreakEvent, child.dwProcessId);
    }

    private static IntPtr NewTreeJob()
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        var limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
            Marshal.SizeOf(typeof(ExtendedLimitInformation)));
        return job;
    }

    private static void ClearKillOnClose()
    {
        var limits = new ExtendedLimitInformation();
        SetInformationJobObject(treeJob, JobObjectExtendedLimitInformation, ref limits,
            Marshal.SizeOf(typeof(ExtendedLimitInformation)));
    }

    private static string WorkspaceJobName(string directory)
    {
        try
        {
            string[] lines = File.ReadAllLines(Path.Combine(directory, ".job"), new UTF8Encoding(false));
            return lines.Length > 0 && lines[0].Length > 0 ? lines[0] : null;
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    private static void JoinWorkspaceJob(string name)
    {
        IntPtr job = OpenJobObjectW(JobObjectAssignProcess, false, name);
        if (job == IntPtr.Zero || !AssignProcessToJobObject(job, child.hProcess))
        {
            Console.Error.WriteLine("fixture launcher: cannot join the workspace job: error " + Marshal.GetLastWin32Error());
        }
    }

    // Tells the harness this launcher still runs. The kernel removes the file
    // when the process ends, however it ends.
    private static void MarkLive(string directory)
    {
        try
        {
            liveFile = new FileStream(Path.Combine(directory, ".live", Guid.NewGuid().ToString("N")), FileMode.CreateNew,
                FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
        }
        catch (IOException) { /* The workspace is going away. */ }
        catch (UnauthorizedAccessException) { /* The workspace is going away. */ }
    }

    private static void WatchStopEvent(string name)
    {
        EventWaitHandle stop;
        try
        {
            stop = EventWaitHandle.OpenExisting(name);
        }
        catch (WaitHandleCannotBeOpenedException) { return; }
        catch (UnauthorizedAccessException) { return; }
        var watcher = new Thread(() =>
        {
            stop.WaitOne();
            Stop();
        });
        watcher.IsBackground = true;
        watcher.Start();
    }

    // The path this copy was started from, so a hard link finds the .shim beside it.
    private static string OwnPath()
    {
        var name = new StringBuilder(32768);
        GetModuleFileNameW(IntPtr.Zero, name, (uint)name.Capacity);
        return name.ToString();
    }

    // The child gets the three stdio handles and nothing else this process could
    // pass on. A stray inherited pipe end would reach a detached grandchild, keep
    // the caller's pipes open after the tool exits, and hang the caller's spawnSync.
    private static bool LimitInheritanceToStdio(ref StartupInfoEx startup)
    {
        var handles = new List<IntPtr>();
        foreach (IntPtr handle in new[] { startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError })
        {
            if (handle != IntPtr.Zero && handle != new IntPtr(-1) && !handles.Contains(handle)) handles.Add(handle);
        }
        if (handles.Count == 0) return false;

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        IntPtr values = Marshal.AllocHGlobal(IntPtr.Size * handles.Count);
        for (int index = 0; index < handles.Count; index++) Marshal.WriteIntPtr(values, index * IntPtr.Size, handles[index]);
        if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)
            || !UpdateProcThreadAttribute(list, 0, AttributeHandleList, values, new IntPtr(IntPtr.Size * handles.Count), IntPtr.Zero, IntPtr.Zero))
        {
            return true;
        }
        startup.lpAttributeList = list;
        return true;
    }

    private static IntPtr Inheritable(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1))
        {
            SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit);
        }
        return handle;
    }

    // Everything after the program name, by the rule Windows uses for argv[0]:
    // up to the closing quote if it starts with one, else up to the first blank.
    private static string ArgumentsOf(string commandLine)
    {
        int index = 0;
        if (commandLine.Length > 0 && commandLine[0] == '"')
        {
            index = commandLine.IndexOf('"', 1);
            index = index < 0 ? commandLine.Length : index + 1;
        }
        else
        {
            while (index < commandLine.Length && commandLine[index] != ' ' && commandLine[index] != '\t') index++;
        }
        while (index < commandLine.Length && (commandLine[index] == ' ' || commandLine[index] == '\t')) index++;
        return commandLine.Substring(index);
    }

    private static void AppendQuoted(StringBuilder target, string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            target.Append(value);
            return;
        }
        target.Append('"');
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            target.Append('\\', c == '"' ? backslashes * 2 + 1 : backslashes);
            backslashes = 0;
            target.Append(c);
        }
        target.Append('\\', backslashes * 2);
        target.Append('"');
    }
}
