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
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class FixtureShim
{
    private const int StdInput = -10;
    private const int StdOutput = -11;
    private const int StdError = -12;
    private const uint HandleFlagInherit = 1;
    private const uint StartfUseStdHandles = 0x100;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private static readonly IntPtr AttributeHandleList = new IntPtr(0x00020002);
    private const uint Infinite = 0xFFFFFFFF;

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
    private static extern IntPtr GetConsoleWindow();

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

        // A detached launcher has no console, and a console child would open a window.
        uint flags = (GetConsoleWindow() == IntPtr.Zero ? CreateNoWindow : 0) | ExtendedStartupInfoPresent;
        ProcessInformation child;
        if (!CreateProcessW(lines[0], commandLine, IntPtr.Zero, IntPtr.Zero, inherit, flags, IntPtr.Zero, null,
                ref startup, out child))
        {
            Console.Error.WriteLine("fixture launcher: cannot start " + lines[0] + ": error " + Marshal.GetLastWin32Error());
            return 126;
        }
        WaitForSingleObject(child.hProcess, Infinite);
        uint exitCode;
        GetExitCodeProcess(child.hProcess, out exitCode);
        return unchecked((int)exitCode);
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
