/* Expose Electron's Node runtime as node.exe without copying a runtime. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static const wchar_t *argumentTail(const wchar_t *commandLine) {
  BOOL quoted = FALSE;
  /* Only argv[0] is replaced. Preserve the already-escaped argument tail. */
  while (*commandLine) {
    if (*commandLine == L'"') quoted = !quoted;
    else if (!quoted && (*commandLine == L' ' || *commandLine == L'\t')) break;
    ++commandLine;
  }
  return commandLine;
}

static BOOL WINAPI ignoreConsoleInterrupt(DWORD event) {
  /* Electron receives the same console signal; wait for its exit status. */
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

int wmain(void) {
  wchar_t *executable = NULL;
  const wchar_t *tail = argumentTail(GetCommandLineW());
  wchar_t commandLine[32768];
  size_t executableLength, tailLength;
  STARTUPINFOW startup = { 0 };
  PROCESS_INFORMATION child = { 0 };
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobInfo = { 0 };
  HANDLE job = NULL;
  HANDLE inherited[3] = { NULL, NULL, NULL };
  DWORD standardIds[3] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
  HANDLE *standardHandles[3] = {
    &startup.hStdInput, &startup.hStdOutput, &startup.hStdError
  };
  DWORD error = 0, exitCode = 1;
  const char *failure = "ELECTRON_NODE_EXEC_PATH must name the current Electron executable";
  int index;

  if (_wdupenv_s(&executable, NULL, L"ELECTRON_NODE_EXEC_PATH") ||
      !executable || !*executable) goto cleanup;
  executableLength = wcslen(executable);
  tailLength = wcslen(tail);
  failure = "forwarded command line exceeds the Windows limit";
  if (executableLength + tailLength + 3 > 32767) goto cleanup;
  commandLine[0] = L'"';
  wmemcpy(commandLine + 1, executable, executableLength);
  commandLine[executableLength + 1] = L'"';
  wmemcpy(commandLine + executableLength + 2, tail, tailLength + 1);

  failure = "cannot set ELECTRON_RUN_AS_NODE";
  if (!SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1")) goto windowsError;
  /* Only this process owns the job handle. Killing the launcher therefore
   * kills Electron and its descendants, including on timeout or AbortSignal. */
  failure = "cannot create the Electron process job";
  job = CreateJobObjectW(NULL, NULL);
  if (!job) goto windowsError;
  jobInfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  failure = "cannot configure the Electron process job";
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jobInfo,
      sizeof(jobInfo))) goto windowsError;

  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  failure = "cannot inherit a standard stream";
  for (index = 0; index < 3; ++index) {
    HANDLE handle = GetStdHandle(standardIds[index]);
    *standardHandles[index] = handle;
    if (handle && handle != INVALID_HANDLE_VALUE) {
      if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(),
          &inherited[index], 0, TRUE, DUPLICATE_SAME_ACCESS)) goto windowsError;
      *standardHandles[index] = inherited[index];
    }
  }
  SetConsoleCtrlHandler(ignoreConsoleInterrupt, TRUE);
  failure = "cannot start ELECTRON_NODE_EXEC_PATH";
  if (!CreateProcessW(executable, commandLine, NULL, NULL, TRUE, CREATE_SUSPENDED,
      NULL, NULL, &startup, &child)) goto windowsError;
  /* Electron cannot run or create descendants before the job owns it. */
  failure = "cannot assign Electron to its process job";
  if (!AssignProcessToJobObject(job, child.hProcess)) goto windowsError;
  failure = "cannot resume the Electron process";
  if (ResumeThread(child.hThread) == (DWORD)-1) goto windowsError;
  failure = "cannot read the Electron process exit code";
  if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 ||
      !GetExitCodeProcess(child.hProcess, &exitCode)) goto windowsError;

  /* Normal Node exit must preserve deliberately detached, unref'ed children.
   * Cancellation and failures keep the job's tree cleanup enabled. */
  jobInfo.BasicLimitInformation.LimitFlags = 0;
  failure = "cannot release the completed Electron process job";
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jobInfo,
      sizeof(jobInfo))) goto windowsError;
  failure = NULL;
  goto cleanup;

windowsError:
  error = GetLastError();
cleanup:
  if (failure && child.hProcess) TerminateProcess(child.hProcess, 1);
  if (job) CloseHandle(job);
  if (child.hProcess) {
    if (failure) WaitForSingleObject(child.hProcess, INFINITE);
    CloseHandle(child.hProcess);
  }
  if (child.hThread) CloseHandle(child.hThread);
  for (index = 0; index < 3; ++index) {
    if (inherited[index]) CloseHandle(inherited[index]);
  }
  free(executable);
  if (failure) {
    fprintf(stderr, "DSH node launcher: %s (Windows error %lu)\n", failure, error);
  }
  ExitProcess(failure ? 1 : exitCode);
}
