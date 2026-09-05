import ctypes
import json
import os
import selectors
import signal
import subprocess
import sys
import time


def main():
    if sys.platform != "linux" or os.getpid() != 1:
        return 2
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
        return 2
    selector = selectors.DefaultSelector()
    os.set_blocking(0, False)
    selector.register(0, selectors.EVENT_READ)
    pending = bytearray()
    incoming = bytearray()
    expiry = time.monotonic() + 0.4
    deadline = None
    child = None
    stopping = False

    def stop(_signal=None, _frame=None):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping and time.monotonic() < expiry:
            if child is not None and child.poll() is not None:
                return child.returncode
            for key, _event in selector.select(min(0.05, max(0, expiry - time.monotonic()))):
                if key.fd == 0:
                    chunk = os.read(0, 65536)
                    if not chunk:
                        stop()
                        break
                    incoming.extend(chunk)
                    if len(incoming) > 8 * 1024 * 1024:
                        stop()
                        break
                    while b"\n" in incoming:
                        line, _, remainder = incoming.partition(b"\n")
                        incoming = bytearray(remainder)
                        message = json.loads(line)
                        if message.get("type") == "provider-response":
                            if child is None:
                                stop()
                                break
                        else:
                            now = time.time() * 1000
                            requested = message.get("deadlineEpochMs", 0)
                            valid_until = message.get("validUntilEpochMs", 0)
                            if child is None and valid_until <= now:
                                continue
                            if not isinstance(requested, (int, float)) or not isinstance(valid_until, (int, float)) or not 0 < valid_until - now <= 500 or not valid_until <= requested <= now + 7200000 or (deadline is not None and requested > deadline):
                                stop()
                                break
                            deadline = requested
                            expiry = time.monotonic() + max(0, valid_until - now - 100) / 1000
                            if child is None:
                                child = subprocess.Popen(["node", "/aq-harness/dist/delivery/container-guard.js", *sys.argv[1:]], stdin=subprocess.PIPE, start_new_session=True)
                                os.set_blocking(child.stdin.fileno(), False)
                        pending.extend(line + b"\n")
                        if len(pending) > 8 * 1024 * 1024:
                            stop()
                            break
                        if child is not None:
                            try:
                                selector.register(child.stdin, selectors.EVENT_WRITE)
                            except KeyError:
                                pass
                elif child is not None and pending:
                    try:
                        written = os.write(child.stdin.fileno(), pending)
                        del pending[:written]
                    except BlockingIOError:
                        pass
                    if not pending:
                        selector.unregister(child.stdin)
    except (OSError, ValueError, TypeError):
        stop()
    finally:
        selector.close()
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=0.1)
            except (OSError, subprocess.TimeoutExpired):
                pass
    return 143


if __name__ == "__main__":
    sys.exit(main())
