FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    YANGER_DIR=/opt/yanger \
    WORKDIR=/workdir \
    PATH=/opt/yanger/bin:$PATH

# install apt packages needed for building/using yanger + inotify + node/npm
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential git curl ca-certificates \
      erlang libxml2-dev make inotify-tools nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Install swagger2openapi globally (npm)
RUN npm install -g swagger2openapi

# Install Poetry to /opt/poetry and make it visible to all layers
ENV POETRY_HOME="/opt/poetry"
RUN curl -sSL https://install.python-poetry.org | POETRY_HOME="$POETRY_HOME" python3 -
ENV PATH="$POETRY_HOME/bin:$PATH"

# Make Poetry install into system site-packages (no virtualenv)
ENV POETRY_VIRTUALENVS_CREATE=false \
    POETRY_NO_INTERACTION=1

# copy poetry files for layer caching
COPY pyproject.toml poetry.lock* /tmp/

WORKDIR /tmp
RUN poetry --version && poetry install --no-root

# Clone and build yanger (from upstream repo)
RUN git clone --depth 1 https://github.com/mbj4668/yanger "${YANGER_DIR}" \
 && cd "${YANGER_DIR}" \
 && /bin/bash -lc "source env.sh || true; make" \
 # ensure yanger bin is executable and available
 && chmod +x "${YANGER_DIR}/bin/yanger"

# Remove build-only packages and Poetry
RUN apt-get purge -y --auto-remove build-essential git make libxml2-dev \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* "$POETRY_HOME"

# copy yang_optimization folder into the image (not exposed to the mounted workdir)
COPY yang_optimization /opt/yang_optimization
RUN chmod -R a+rX /opt/yang_optimization

# copy the baked watcher into the image
COPY watcher.py /usr/local/bin/watcher.py
RUN chmod +x /usr/local/bin/watcher.py

 # add watcher script (overwrite with your local version at runtime if you mount workspace)
COPY watch-yang.sh /usr/local/bin/watch-yang.sh
RUN chmod +x /usr/local/bin/watch-yang.sh

WORKDIR /workdir

# default: run the watcher
ENTRYPOINT ["/usr/local/bin/watch-yang.sh"]