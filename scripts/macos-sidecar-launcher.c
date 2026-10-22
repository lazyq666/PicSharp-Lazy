#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
    char executable[PATH_MAX];
    char resolved[PATH_MAX];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) != 0 || !realpath(executable, resolved)) {
        fprintf(stderr, "Cannot locate PicSharp's bundled helper.\n");
        return 1;
    }

    const char *macos = dirname(resolved);
    char node[PATH_MAX];
    char entry[PATH_MAX];
    int node_length = snprintf(node, sizeof(node), "%s/../Resources/resources/sidecar/node", macos);
    int entry_length = snprintf(entry, sizeof(entry), "%s/../Resources/resources/sidecar/dist/index.js", macos);
    if (node_length < 0 || (size_t)node_length >= sizeof(node) || entry_length < 0 || (size_t)entry_length >= sizeof(entry)) {
        fprintf(stderr, "PicSharp's application path is too long.\n");
        return 1;
    }

    setenv("DOTENV_CONFIG_QUIET", "true", 1);
    char *const args[] = {node, entry, NULL};
    execv(node, args);
    int failure = errno;
    perror("Cannot start PicSharp's bundled Node.js runtime");
    return failure == ENOENT ? 127 : 1;
}
