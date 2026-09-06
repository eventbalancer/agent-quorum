export const PROVIDER_CONFINEMENT_PROGRAM = String.raw`
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int is_denied(int error) {
    return error == EACCES || error == EPERM;
}

static const char *boolean(int value) {
    return value ? "true" : "false";
}

static int reads_evidence(const char *file) {
    const char expected[] = "owned evidence";
    char content[sizeof(expected)] = {0};
    int descriptor = open(file, O_RDONLY);
    if (descriptor < 0) {
        return 0;
    }
    ssize_t length = read(descriptor, content, sizeof(content));
    close(descriptor);
    return length == sizeof(expected) - 1 &&
        memcmp(content, expected, sizeof(expected) - 1) == 0;
}

static int denies_open(const char *file, int flags) {
    int descriptor = open(file, flags, 0600);
    if (descriptor < 0) {
        return is_denied(errno);
    }
    close(descriptor);
    return 0;
}

static void connection_timeout(int signal_number) {
    (void)signal_number;
    _exit(124);
}

static int denies_network(void) {
    int connection = socket(AF_INET, SOCK_STREAM, 0);
    if (connection < 0) {
        return 0;
    }
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = htons(443);
    if (inet_pton(AF_INET, "1.1.1.1", &address.sin_addr) != 1 ||
        signal(SIGALRM, connection_timeout) == SIG_ERR) {
        close(connection);
        return 0;
    }
    alarm(2);
    int connected = connect(connection, (struct sockaddr *)&address, sizeof(address));
    int error = errno;
    alarm(0);
    close(connection);
    return connected < 0 && is_denied(error);
}

int main(int argc, char **argv) {
    if (argc != 4) {
        return 2;
    }
    int allowed = reads_evidence(argv[1]);
    int denied_read = denies_open(argv[2], O_RDONLY);
    int denied_write = denies_open(argv[3], O_WRONLY | O_CREAT | O_EXCL);
    int denied_network = allowed && denied_read && denied_write && denies_network();
    printf("{\"allowed\":%s,\"denied_read\":%s,\"denied_write\":%s,\"denied_network\":%s}\n",
           boolean(allowed), boolean(denied_read), boolean(denied_write), boolean(denied_network));
    return allowed && denied_read && denied_write && denied_network ? 0 : 1;
}
`;
