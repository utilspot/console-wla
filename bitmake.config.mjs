// RUN npx bitmake build

const environment = {};
const prefix = "/package";
const destDir = "${binaryRoot}";

export default {
  "bundle:zlib": {
    sourceUrl: "https://zlib.net/zlib-1.3.2.tar.gz",
    action: "configure",
    variables: {
      prefix,
    },
    features: [
      "static",
    ],
    environment,
    destDir,
  },
  "bundle:openssl": {
    sourceUrl: "https://github.com/openssl/openssl/releases/download/openssl-3.4.0/openssl-3.4.0.tar.gz",
    action: [
      {
        action: "process",
        command: "./Configure",
        args: [
          "zlib",
          "threads",
          "no-shared",
          "no-legacy",
          "no-apps",
          "no-docs",
          "no-tests",
          `--prefix=${prefix}`,
          `--openssldir=${prefix}/etc/ssl`,
          "--with-zlib-include=" + destDir + `${prefix}/include`,
          "--with-zlib-lib=" + destDir + `${prefix}/lib`,
          "--libdir=lib",
        ],
      },
      {
        action: "make",
        args: [ "install" ],
      },
    ],
    binaryDir: "${sourceDir}",
    environment,
    destDir,
  },
  "bundle:civetweb": {
    sourceUrl: "https://github.com/civetweb/civetweb/archive/refs/tags/v1.16.tar.gz",
    action: "cmake",
    cacheVariables: {
      CMAKE_POLICY_VERSION_MINIMUM: "3.5",
      CMAKE_PREFIX_PATH: destDir + prefix,
      CMAKE_INSTALL_PREFIX: prefix,
      BUILD_SHARED_LIBS: false,
      BUILD_TESTING: false,
      CIVETWEB_ENABLE_ASAN: false,
      CIVETWEB_BUILD_TESTING: false,
      CIVETWEB_ENABLE_SERVER_EXECUTABLE: false,
      CIVETWEB_ENABLE_WEBSOCKETS: true,
      CIVETWEB_ENABLE_ZLIB: true,
    },
    environment,
    destDir,
  },
  "bundle:jansson": {
    sourceUrl: "https://github.com/akheron/jansson/releases/download/v2.15.0/jansson-2.15.0.tar.gz",
    action: "cmake",
    cacheVariables: {
      CMAKE_PREFIX_PATH: destDir + prefix,
      CMAKE_INSTALL_PREFIX: prefix,
      JANSSON_BUILD_SHARED_LIBS: false,
      JANSSON_BUILD_DOCS: false,
      JANSSON_EXAMPLES: false,
    },
    environment,
    destDir,
  },
  "bundle:libnetq": {
    sourceUrl: "https://github.com/yacubin/libnetq/archive/refs/tags/v1.0.19.tar.gz",
    action: "cmake",
    cacheVariables: {
      CMAKE_PREFIX_PATH: destDir + prefix,
      CMAKE_INSTALL_PREFIX: prefix,
      LNQ_LIBRARY_TYPE: "SHARED",
      LNQ_WITH_ZLIB: true,
      LNQ_WITH_OPENSSL: true,
      LNQ_WITH_JANSSON: true,
      LNQ_WITH_CIVETWEB: true,
    },
    environment,
    destDir,
  },
  "bundle:output": {
    action: "cmake",
    cacheVariables: {
      CMAKE_MODULE_PATH: destDir + `${prefix}/share/libnetq/cmake`,
      CMAKE_PREFIX_PATH: destDir + prefix,
      CMAKE_INSTALL_PREFIX: prefix,
    },
    sourceDir: "${sourceRoot}",
    environment,
    destDir,
    rebuild: true,
  },
};
