# YANG-OAS Real-Time Generation
Watch a directory of YANG models and regenerate API artifacts in real time:
- `swagger.json` — generated from YANG by yanger
- `oas3.json` — converted from swagger.json by `swagger2openapi`
- `filtered-oas3.json` — optional, annotation-driven filtering result

This repository contains:
- `watch-yang.sh` — watcher script that regenerates Swagger/OAS3 when .yang files change. It runs yanger, converts the result with swagger2openapi, and (optionally) runs the OAS endpoint-optimization pipeline.

- `yang_optimization/` — contains utilities and scripts that filter and enhance the generated OAS (e.g. fill_yang_library.py, regenerate_oas.py, and utils/). These are included in the container image and used by the watcher at runtime.

- `pyproject.toml & poetry.lock` — dependency manifest for Poetry (the project’s Python dependency manager). Poetry installs helper libraries required by the optimizer, e.g. yangson, pydantic, and pyang.

- `Dockerfile` — builds a portable container image that bundles yanger, the watcher script, runtime dependencies, and the *yang_optimization* tools. Use it to run the watcher via docker run or docker compose.

## Features
- Real-time regeneration on file changes (inotify)
- Containerized execution
- Logging to watch-yang.log
- Optional annotation-driven filtering step

## Prerequisites
- `Docker` (or `Podman`)

## Installation
```
docker build -t yang-watcher:latest .
```

## Quick start
```
Use the template below to run the yang-watcher image. Replace the <...> placeholders with concrete values.

$ docker run --rm -it \
  --name yang-watcher \
  -v "<HOST_MODULES_DIR>":/workdir:rw \
  -w /workdir \
  -e WATCH_DIR=/workdir \
  -e MODULES=/workdir/<MODULES_SUBDIR> \
  -e MODEL_FILE=/workdir/<MODULES_SUBDIR>/<MODEL_FILE_NAME> \
  -e MODEL_FILE_NAME=<MODEL_FILE_NAME> \
  -e OUTPUT=/workdir/output/swagger.json \
  -e OAS_OUTPUT=/workdir/output/oas3.json \
  -e ANNOTATION=<true|false> \
  yang-watcher:latest

```
- <HOST_MODULES_DIR> — absolute path on host you want mounted (e.g. /home/hesham/modules)
- <MODULES_SUBDIR> — relative path under workdir containing .yang files (e.g. arp)
- <MODEL_FILE_NAME> — main .yang file name (e.g. ipNetToMediaTable.yang)

## Example — concrete docker run (filled values):
```
$ docker run --rm -it \
  --name yang-watcher \
  -v "/home/hesham/modules":/workdir:rw \
  -w /workdir \
  -e WATCH_DIR=/workdir \
  -e MODULES=/workdir/arp \
  -e MODEL_FILE=/workdir/arp/ipNetToMediaTable.yang \
  -e MODEL_FILE_NAME=ipNetToMediaTable.yang \
  -e OUTPUT=/workdir/output/swagger.json \
  -e OAS_OUTPUT=/workdir/output/oas3.json \
  -e ANNOTATION=true \
  yang-watcher:latest
```