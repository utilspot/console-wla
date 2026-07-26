#include <libnetq/Context.h>
#include <libnetq/web/WebServer.h>

struct NQWebServerParams kServerParams = {
  .host = "localhost:8033",

  .tlsEnabled = false,
  .tlsKey = NULL,
  .tlsCert = NULL,

  .workDir = ".",
  .resourceDir = "www",
};

int main(int argc, const char* argv[])
{
  NQWebServer* server = NQWebServer_create(&kServerParams);
  if (server == NULL)
    return NQ_EXIT_FAILURE;

  int ret = NQWebServer_loadExecutorWLA(server, "console");
  if (ret != 0) {
    NQWebServer_destroy(server);
    return NQ_EXIT_FAILURE;
  }

  NQWebServer_run(server);
  NQWebServer_destroy(server);

  return NQ_EXIT_SUCCESS;
}
