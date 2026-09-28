param(
  [Parameter(Mandatory = $true)][string]$NodeExecutable,
  [Parameter(Mandatory = $true)][string]$ScriptPath,
  [Parameter(Mandatory = $true)][string]$ReadyFile
)

$ErrorActionPreference = 'Stop'
$env:DEVDOCK_READY_FILE = $ReadyFile

$source = @'
using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class DevDockJobProbe : IDisposable {
    private const uint CREATE_NO_WINDOW = 0x08000000;
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
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr job;
    private IntPtr process;
    private IntPtr thread;
    private readonly BlockingCollection<OutputChunk> outputQueue;
    private readonly FileStream stdoutStream;
    private readonly FileStream stderrStream;
    private int activeReaders;
    private int outputStarted;
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
        this.activeReaders = 2;
    }

    private static string QuotePath(string path) {
        if (path.IndexOf('"') >= 0 || path.IndexOf('\r') >= 0 || path.IndexOf('\n') >= 0) {
            throw new ArgumentException("Probe paths cannot contain quotes or line breaks");
        }
        return "\"" + path + "\"";
    }

    private static Exception WindowsError(string operation) {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
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
            foreach (OutputChunk chunk in outputQueue.GetConsumingEnumerable()) {
                WriteDroppedOutputEvent();
                WriteProtocol("{\"type\":\"job-output\",\"stream\":\"" + chunk.Stream +
                    "\",\"data\":\"" + Convert.ToBase64String(chunk.Data) + "\"}");
            }
            WriteDroppedOutputEvent();
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

    public static DevDockJobProbe Start(string executable, string scriptPath) {
        string command = QuotePath(executable) + " " + QuotePath(scriptPath);
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
            created = CreateProcessW(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                true, CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero,
                System.IO.Path.GetDirectoryName(scriptPath), ref startup, out child);
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

    public void Stop() {
        if (job == IntPtr.Zero) throw new ObjectDisposedException("DevDockJobProbe");
        if (!TerminateJobObject(job, 1)) throw WindowsError("TerminateJobObject");
        for (int attempt = 0; attempt < 250; attempt++) {
            if (ActiveProcesses() == 0) return;
            Thread.Sleep(20);
        }
        throw new TimeoutException("Job still has active processes after termination");
    }

    public void Dispose() {
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
  $job = [DevDockJobProbe]::Start($NodeExecutable, $ScriptPath)
  [DevDockJobProbe]::WriteProtocol((@{ type = 'job-ready'; pid = $job.Pid } | ConvertTo-Json -Compress))
  $job.BeginOutputForwarding()
  while ($true) {
    $command = [Console]::In.ReadLine()
    if ($null -eq $command) { break }
    if ($command -eq 'status') {
      [DevDockJobProbe]::WriteProtocol((@{ type = 'job-status'; activeProcesses = $job.ActiveProcesses() } | ConvertTo-Json -Compress))
    } elseif ($command -eq 'stop') {
      $job.Stop()
      [DevDockJobProbe]::WriteProtocol((@{ type = 'job-stopped'; activeProcesses = $job.ActiveProcesses() } | ConvertTo-Json -Compress))
      break
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $job) { $job.Dispose() }
}
