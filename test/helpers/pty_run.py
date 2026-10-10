# Runs a command in a 120x40 pseudo-terminal (like a real terminal window) and relays stdin/stdout. Used by tty.test.ts.
import os, pty, sys, fcntl, termios, struct, select
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])
fds = [fd, 0]
while True:
    r, _, _ = select.select(fds, [], [])
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 1024)
        if not data:
            fds.remove(0)
        else:
            os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
