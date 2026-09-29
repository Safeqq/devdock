$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class DevDockJobProbe : IDisposable {
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const int PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint STILL_ACTIVE = 259;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int OutputQueueCapacity = 128;
    private const int OutputChunkSize = 4096;

    private static readonly object ConsoleGate = new object();

    private sealed class OutputChunk {
        public string Stream { get; private set; }
        public byte[] Data { get; private set; }

        public OutputChunk(string stream, byte[] data) {
            Stream = stream;
            Data = data;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES {
        public uint nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public IntPtr MinimumWorkingSetSize;
        public IntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public IntPtr ProcessMemoryLimit;
        public IntPtr JobMemoryLimit;
        public IntPtr PeakProcessMemoryUsed;
        public IntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass,
        ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string application, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFOEX startup,
        out PROCESS_INFORMATION information);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags,
        ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe,
        ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string path, uint access, uint share,
        ref SECURITY_ATTRIBUTES attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr job;
    private IntPtr process;
    private IntPtr thread;
    private readonly BlockingCollection<OutputChunk> outputQueue;
    private readonly FileStream stdoutStream;
    private readonly FileStream stderrStream;
    private readonly ManualResetEvent outputComplete;
    private int activeReaders;
    private int outputStarted;
    private int lifecycleDecision;
    private int disposed;
    private long droppedBytes;
    public uint Pid { get; private set; }

    private DevDockJobProbe(IntPtr job, PROCESS_INFORMATION information,
        IntPtr stdoutRead, IntPtr stderrRead) {
        this.job = job;
        this.process = information.hProcess;
        this.thread = information.hThread;
        this.Pid = information.dwProcessId;
        this.outputQueue = new BlockingCollection<OutputChunk>(OutputQueueCapacity);
        this.stdoutStream = new FileStream(new SafeFileHandle(stdoutRead, true), FileAccess.Read,
            OutputChunkSize, false);
        this.stderrStream = new FileStream(new SafeFileHandle(stderrRead, true), FileAccess.Read,
            OutputChunkSize, false);
        this.outputComplete = new ManualResetEvent(false);
        this.activeReaders = 2;
    }

    private static string QuoteArgument(string argument) {
        if (argument == null || argument.IndexOf('\0') >= 0) {
            throw new ArgumentException("Arguments cannot be null or contain NUL");
        }
        StringBuilder quoted = new StringBuilder(argument.Length + 2);
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in argument) {
            if (character == '\\') {
                backslashes++;
                continue;
            }
            if (character == '"') {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static string BuildCommandLine(string executable, string[] arguments) {
        if (string.IsNullOrEmpty(executable) || executable.IndexOf('\0') >= 0 ||
            !Path.IsPathRooted(executable)) {
            throw new ArgumentException("Executable must be an absolute path without NUL");
        }
        if (arguments == null) throw new ArgumentNullException("arguments");
        if (arguments.Length > 256) throw new ArgumentException("Too many process arguments");
        StringBuilder command = new StringBuilder(QuoteArgument(executable));
        if (command.Length >= 32767) {
            throw new ArgumentException("Windows command line exceeds 32766 characters");
        }
        foreach (string argument in arguments) {
            command.Append(' ');
            command.Append(QuoteArgument(argument));
            if (command.Length >= 32767) {
                throw new ArgumentException("Windows command line exceeds 32766 characters");
            }
        }
        return command.ToString();
    }

    private static Exception WindowsError(string operation) {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    private static IntPtr BuildEnvironmentBlock(string[] entries) {
        if (entries == null) throw new ArgumentNullException("entries");
        if (entries.Length > 256) throw new ArgumentException("Too many environment entries");
        SortedDictionary<string, string> variables =
            new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        int characterCount = 2;
        foreach (string entry in entries) {
            if (entry == null || entry.IndexOf('\0') >= 0) {
                throw new ArgumentException("Environment entries cannot be null or contain NUL");
            }
            int separator = entry.IndexOf('=');
            if (separator <= 0) throw new ArgumentException("Environment entry has no valid name");
            string name = entry.Substring(0, separator);
            string value = entry.Substring(separator + 1);
            if (variables.ContainsKey(name)) {
                throw new ArgumentException("Duplicate environment variable: " + name);
            }
            variables.Add(name, value);
            characterCount += name.Length + value.Length + 2;
            if (characterCount > 1024 * 1024) {
                throw new ArgumentException("Environment block exceeds 1 MiB");
            }
        }

        StringBuilder block = new StringBuilder(characterCount);
        foreach (KeyValuePair<string, string> variable in variables) {
            block.Append(variable.Key);
            block.Append('=');
            block.Append(variable.Value);
            block.Append('\0');
        }
        block.Append('\0');
        if (variables.Count == 0) block.Append('\0');
        char[] characters = block.ToString().ToCharArray();
        IntPtr pointer = Marshal.AllocHGlobal(characters.Length * sizeof(char));
        Marshal.Copy(characters, 0, pointer, characters.Length);
        return pointer;
    }

    public static void WriteProtocol(string json) {
        lock (ConsoleGate) {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    public void BeginOutputForwarding() {
        if (Interlocked.Exchange(ref outputStarted, 1) != 0) {
            throw new InvalidOperationException("Output forwarding already started");
        }
        StartOutputWriter();
        StartOutputReader("stdout", stdoutStream);
        StartOutputReader("stderr", stderrStream);
        StartCompletionMonitor();
    }

    private void StartOutputReader(string streamName, FileStream source) {
        Thread reader = new Thread(delegate() {
            byte[] buffer = new byte[OutputChunkSize];
            try {
                int count;
                while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
                    byte[] data = new byte[count];
                    Buffer.BlockCopy(buffer, 0, data, 0, count);
                    if (!outputQueue.TryAdd(new OutputChunk(streamName, data))) {
                        Interlocked.Add(ref droppedBytes, count);
                    }
                }
            } catch (ObjectDisposedException) {
            } catch (IOException) {
            } finally {
                source.Dispose();
                if (Interlocked.Decrement(ref activeReaders) == 0) outputQueue.CompleteAdding();
            }
        });
        reader.IsBackground = true;
        reader.Name = "DevDock " + streamName + " reader";
        reader.Start();
    }

    private void StartOutputWriter() {
        Thread writer = new Thread(delegate() {
            try {
                foreach (OutputChunk chunk in outputQueue.GetConsumingEnumerable()) {
                    WriteDroppedOutputEvent();
                    WriteProtocol("{\"type\":\"job-output\",\"stream\":\"" + chunk.Stream +
                        "\",\"data\":\"" + Convert.ToBase64String(chunk.Data) + "\"}");
                }
                WriteDroppedOutputEvent();
            } finally {
                outputComplete.Set();
            }
        });
        writer.IsBackground = true;
        writer.Name = "DevDock output writer";
        writer.Start();
    }

    private void WriteDroppedOutputEvent() {
        long dropped = Interlocked.Exchange(ref droppedBytes, 0);
        if (dropped > 0) {
            WriteProtocol("{\"type\":\"job-output-gap\",\"droppedBytes\":" + dropped + "}");
        }
    }

    private void StartCompletionMonitor() {
        Thread monitor = new Thread(delegate() {
            try {
                while (Interlocked.CompareExchange(ref disposed, 0, 0) == 0 &&
                    Interlocked.CompareExchange(ref lifecycleDecision, 0, 0) == 0) {
                    uint exitCode;
                    if (TryGetCompletion(out exitCode)) {
                        if (Interlocked.CompareExchange(ref lifecycleDecision, 2, 0) == 0) {
                            WriteProtocol("{\"type\":\"job-exited\",\"activeProcesses\":0," +
                                "\"rootExitCode\":" + exitCode + "}");
                            Environment.Exit(0);
                        }
                        return;
                    }
                    Thread.Sleep(20);
                }
            } catch (Exception error) {
                Console.Error.WriteLine(error.Message);
                Environment.Exit(1);
            }
        });
        monitor.IsBackground = true;
        monitor.Name = "DevDock completion monitor";
        monitor.Start();
    }

    public static DevDockJobProbe Start(string executable, string[] arguments,
        string currentDirectory, string[] environmentEntries) {
        string command = BuildCommandLine(executable, arguments);
        if (string.IsNullOrEmpty(currentDirectory) || currentDirectory.IndexOf('\0') >= 0 ||
            !Path.IsPathRooted(currentDirectory)) {
            throw new ArgumentException("Current directory must be an absolute path without NUL");
        }
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw WindowsError("CreateJobObject");
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        bool created = false;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        IntPtr inheritedHandles = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        IntPtr nullInput = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        bool attributesInitialized = false;
        try {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) {
                throw WindowsError("SetInformationJobObject");
            }
            SECURITY_ATTRIBUTES pipeAttributes = new SECURITY_ATTRIBUTES();
            pipeAttributes.nLength = (uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            pipeAttributes.bInheritHandle = true;
            if (!CreatePipe(out stdoutRead, out stdoutWrite, ref pipeAttributes, 0)) {
                throw WindowsError("CreatePipe stdout");
            }
            if (!SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)) {
                throw WindowsError("SetHandleInformation stdout");
            }
            if (!CreatePipe(out stderrRead, out stderrWrite, ref pipeAttributes, 0)) {
                throw WindowsError("CreatePipe stderr");
            }
            if (!SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0)) {
                throw WindowsError("SetHandleInformation stderr");
            }
            nullInput = CreateFileW("NUL", GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE, ref pipeAttributes, OPEN_EXISTING, 0,
                IntPtr.Zero);
            if (nullInput == new IntPtr(-1)) {
                nullInput = IntPtr.Zero;
                throw WindowsError("CreateFileW NUL");
            }

            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
            if (attributeSize == IntPtr.Zero) throw WindowsError("InitializeProcThreadAttributeList size");
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeSize)) {
                throw WindowsError("InitializeProcThreadAttributeList");
            }
            attributesInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(attributeList, 0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST), jobList, new IntPtr(IntPtr.Size),
                IntPtr.Zero, IntPtr.Zero)) {
                throw WindowsError("UpdateProcThreadAttribute job list");
            }
            inheritedHandles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(inheritedHandles, 0, nullInput);
            Marshal.WriteIntPtr(inheritedHandles, IntPtr.Size, stdoutWrite);
            Marshal.WriteIntPtr(inheritedHandles, IntPtr.Size * 2, stderrWrite);
            if (!UpdateProcThreadAttribute(attributeList, 0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), inheritedHandles,
                new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) {
                throw WindowsError("UpdateProcThreadAttribute handle list");
            }
            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = nullInput;
            startup.StartupInfo.hStdOutput = stdoutWrite;
            startup.StartupInfo.hStdError = stderrWrite;
            startup.lpAttributeList = attributeList;
            environmentBlock = BuildEnvironmentBlock(environmentEntries);
            created = CreateProcessW(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                true, CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                environmentBlock,
                currentDirectory, ref startup, out child);
            if (!created) throw WindowsError("CreateProcessW");
            CloseHandle(stdoutWrite);
            stdoutWrite = IntPtr.Zero;
            CloseHandle(stderrWrite);
            stderrWrite = IntPtr.Zero;
            CloseHandle(nullInput);
            nullInput = IntPtr.Zero;
            bool inJob;
            if (!IsProcessInJob(child.hProcess, job, out inJob)) throw WindowsError("IsProcessInJob");
            if (!inJob) throw new InvalidOperationException("Created process is outside its job");
            DevDockJobProbe probe = new DevDockJobProbe(job, child, stdoutRead, stderrRead);
            stdoutRead = IntPtr.Zero;
            stderrRead = IntPtr.Zero;
            return probe;
        } catch {
            if (created) {
                TerminateProcess(child.hProcess, 1);
                CloseHandle(child.hThread);
                CloseHandle(child.hProcess);
            }
            CloseHandle(job);
            throw;
        } finally {
            if (attributesInitialized) DeleteProcThreadAttributeList(attributeList);
            if (inheritedHandles != IntPtr.Zero) Marshal.FreeHGlobal(inheritedHandles);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (stdoutRead != IntPtr.Zero) CloseHandle(stdoutRead);
            if (stdoutWrite != IntPtr.Zero) CloseHandle(stdoutWrite);
            if (stderrRead != IntPtr.Zero) CloseHandle(stderrRead);
            if (stderrWrite != IntPtr.Zero) CloseHandle(stderrWrite);
            if (nullInput != IntPtr.Zero) CloseHandle(nullInput);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
        }
    }

    public uint ActiveProcesses() {
        if (job == IntPtr.Zero) throw new ObjectDisposedException("DevDockJobProbe");
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information =
            new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
        int returned;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, ref information,
            Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), out returned)) {
            throw WindowsError("QueryInformationJobObject");
        }
        return information.ActiveProcesses;
    }

    private bool TryGetCompletion(out uint exitCode) {
        if (job == IntPtr.Zero || process == IntPtr.Zero) {
            throw new ObjectDisposedException("DevDockJobProbe");
        }
        exitCode = 0;
        uint wait = WaitForSingleObject(process, 0);
        if (wait == WAIT_FAILED) throw WindowsError("WaitForSingleObject");
        if (wait != WAIT_OBJECT_0 || ActiveProcesses() != 0 || !outputComplete.WaitOne(0)) {
            return false;
        }
        uint observed;
        if (!GetExitCodeProcess(process, out observed)) throw WindowsError("GetExitCodeProcess");
        if (observed == STILL_ACTIVE) return false;
        exitCode = observed;
        return true;
    }

    public uint RootExitCode() {
        if (process == IntPtr.Zero) throw new ObjectDisposedException("DevDockJobProbe");
        uint exitCode;
        if (!GetExitCodeProcess(process, out exitCode)) throw WindowsError("GetExitCodeProcess");
        if (exitCode == STILL_ACTIVE) {
            throw new InvalidOperationException("Root process is still active");
        }
        return exitCode;
    }

    public bool Stop() {
        if (job == IntPtr.Zero) throw new ObjectDisposedException("DevDockJobProbe");
        if (Interlocked.CompareExchange(ref lifecycleDecision, 1, 0) != 0) return false;
        if (!TerminateJobObject(job, 1)) throw WindowsError("TerminateJobObject");
        for (int attempt = 0; attempt < 250; attempt++) {
            if (ActiveProcesses() == 0) {
                if (!outputComplete.WaitOne(5000)) {
                    throw new TimeoutException("Output did not drain after job termination");
                }
                return true;
            }
            Thread.Sleep(20);
        }
        throw new TimeoutException("Job still has active processes after termination");
    }

    public void Dispose() {
        Interlocked.Exchange(ref disposed, 1);
        Interlocked.CompareExchange(ref lifecycleDecision, 1, 0);
        if (Interlocked.CompareExchange(ref outputStarted, 1, 1) == 0) {
            stdoutStream.Dispose();
            stderrStream.Dispose();
        }
        if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    }
}
'@

$job = $null
try {
  Add-Type -TypeDefinition $source -Language CSharp
  $launchLine = [Console]::In.ReadLine()
  if ($null -eq $launchLine) { throw 'Launch request is required' }
  $envelope = $launchLine | ConvertFrom-Json
  if ($envelope.type -ne 'launch' -or $envelope.data -isnot [string]) {
    throw 'First command must be a launch request with a base64 payload'
  }
  $launchJson = [System.Text.Encoding]::UTF8.GetString(
    [System.Convert]::FromBase64String($envelope.data)
  )
  $launch = $launchJson | ConvertFrom-Json
  if ($launch.executable -isnot [string] -or $launch.canonicalCwd -isnot [string] -or
      $null -eq $launch.args -or $null -eq $launch.environment) {
    throw 'Launch payload must contain executable, args, canonicalCwd, and environment'
  }
  $arguments = [System.Collections.Generic.List[string]]::new()
  foreach ($argument in @($launch.args)) {
    if ($argument -isnot [string]) { throw 'Every process argument must be a string' }
    $arguments.Add($argument)
  }
  $environmentEntries = [System.Collections.Generic.List[string]]::new()
  foreach ($property in $launch.environment.PSObject.Properties) {
    if ($property.Value -isnot [string]) {
      throw "Environment value must be a string: $($property.Name)"
    }
    $environmentEntries.Add("$($property.Name)=$($property.Value)")
  }
  $job = [DevDockJobProbe]::Start(
    $launch.executable,
    $arguments.ToArray(),
    $launch.canonicalCwd,
    $environmentEntries.ToArray()
  )
  [DevDockJobProbe]::WriteProtocol((@{ type = 'job-ready'; pid = $job.Pid } | ConvertTo-Json -Compress))
  $job.BeginOutputForwarding()
  while ($true) {
    $command = [Console]::In.ReadLine()
    if ($null -eq $command) { break }
    if ($command -eq 'status') {
      [DevDockJobProbe]::WriteProtocol((@{ type = 'job-status'; activeProcesses = $job.ActiveProcesses() } | ConvertTo-Json -Compress))
    } elseif ($command -eq 'stop') {
      if ($job.Stop()) {
        [DevDockJobProbe]::WriteProtocol((@{
          type = 'job-stopped'
          activeProcesses = $job.ActiveProcesses()
          rootExitCode = [long]$job.RootExitCode()
        } | ConvertTo-Json -Compress))
        break
      }
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $job) { $job.Dispose() }
}
