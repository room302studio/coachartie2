Need to fix this error: => WARN: FromAsCasing: 'as' and 'FROM' keywords' casing do not match (line 5) 0.0s
=> [brain internal] load metadata for docker.io/library/node:20-slim 0.6s
=> [brain internal] load .dockerignore 0.0s
=> [brain internal] load build context 30.5s
=> => transferring context: 2.06GB 30.0s
=> [brain build 1/8] FROM docker.io/library/node:20-slim@sha256:6db5e436948af8f0244488a1f658c2c8e55a3ae51ca2e1686ed042be 0.0s
=> CACHED [brain build 2/8] WORKDIR /app 0.0s
=> CACHED [brain stage-1 3/4] RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/\* 0.0s
=> CACHED [brain build 3/8] COPY package.json ./ 0.0s
=> CACHED [brain build 4/8] RUN npm cache clean --force 0.0s
=> CACHED [brain build 5/8] RUN npm install nuxt@^3.13.0 --save-dev 0.0s
=> CACHED [brain build 6/8] RUN npm install 0.0s
=> ERROR [brain build 7/8] COPY . . 9.1s

---

> [brain build 7/8] COPY . .:

---

failed to solve: cannot replace to directory /var/lib/docker/overlay2/mhj6cym8e9ua1j9ux75scyw4v/merged/app/node_modules/@ampproject/remapping with file
❯ nvim docker-compose.yml
