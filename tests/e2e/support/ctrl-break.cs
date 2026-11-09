// Starts a program in its own process group and raises Ctrl+Break in that group
// on request. Node cannot do either: `detached` also removes the console, and a
// console is what carries the event; child.kill() on Windows is a forced kill.
//
//   ctrl-break.exe <program> [args...]
//
// The harness starts this with no window, so it owns a hidden console that the
// program shares. Each line "break" on stdin raises CTRL_BREAK_EVENT in the
// program's group. The exit code is the program's, and the program goes when
// this process goes (a job object), so a forced teardown leaves nothing running.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class CtrlBreak
{
    private const int StdOutput = -11;
    private const int StdError = -12;
    private const uint HandleFlagInherit = 1;
    private const uint StartfUseStdHandles = 0x100;
    private const uint CreateSuspended = 0x4;
    private const uint CreateNewProcessGroup = 0x200;
    private const uint CtrlBreakEvent = 1;
    private const uint Infinite = 0xFFFFFFFF;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

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
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetCommandLineW();

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int which);

    [DllImport("kernel32.dll")]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string application, System.Text.StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    private static int Main()
    {
        string arguments = ArgumentsOf(Marshal.PtrToStringUni(GetCommandLineW()));
        if (arguments.Length == 0)
        {
            Console.Error.WriteLine("ctrl-break: name a program to run");
            return 127;
        }
        IntPtr job = KillOnCloseJob();

        var startup = new StartupInfo();
        startup.cb = Marshal.SizeOf(typeof(StartupInfo));
        startup.dwFlags = StartfUseStdHandles;
        startup.hStdInput = IntPtr.Zero;
        startup.hStdOutput = Inheritable(GetStdHandle(StdOutput));
        startup.hStdError = Inheritable(GetStdHandle(StdError));

        ProcessInformation child;
        var commandLine = new System.Text.StringBuilder(arguments);
        if (!CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, true, CreateNewProcessGroup | CreateSuspended,
                IntPtr.Zero, null, ref startup, out child))
        {
            Console.Error.WriteLine("ctrl-break: cannot start: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
            return 126;
        }
        AssignProcessToJobObject(job, child.hProcess);
        ResumeThread(child.hThread);

        uint group = child.dwProcessId;
        var input = new Thread(() => ForwardBreaks(group)) { IsBackground = true };
        input.Start();

        WaitForSingleObject(child.hProcess, Infinite);
        uint exitCode;
        GetExitCodeProcess(child.hProcess, out exitCode);
        return unchecked((int)exitCode);
    }

    private static void ForwardBreaks(uint group)
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (line.Trim() == "break") GenerateConsoleCtrlEvent(CtrlBreakEvent, group);
            }
        }
        catch (IOException) { /* The harness went away. */ }
    }

    private static IntPtr KillOnCloseJob()
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        var limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
            Marshal.SizeOf(typeof(ExtendedLimitInformation)));
        return job;
    }

    private static IntPtr Inheritable(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1))
        {
            SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit);
        }
        return handle;
    }

    // Everything after the program name, by the rule Windows uses for argv[0].
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
}
