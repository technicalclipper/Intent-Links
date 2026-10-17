# The policy service (apps/api) for Cloud Run: the authority, the consent
# pages, the landing page and the extension download.
#
# The extension is built INTO this image. The landing page's download button
# zips apps/extension/dist on request, and without it that button returns 503.
#
#   gcloud run deploy intentlink-api --source . --region <region> \
#     --set-env-vars INTENTLINK_STORE=firestore,INTENTLINK_AGENT_URL=<agent url> \
#     --set-secrets INTENTLINK_TOKEN_SECRET=<secret>:latest,GOOGLE_API_KEY=<secret>:latest

FROM node:26-slim AS build
WORKDIR /app

# Manifests first, so dependency installs are cached across source edits.
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/schema/package.json packages/schema/
COPY packages/a11y/package.json packages/a11y/
COPY packages/policy/package.json packages/policy/
COPY packages/compiler/package.json packages/compiler/
COPY apps/api/package.json apps/api/
COPY apps/extension/package.json apps/extension/
RUN npm ci

COPY packages packages
COPY apps/api apps/api
COPY apps/extension apps/extension

# Every TypeScript project in dependency order, then the extension bundle,
# which needs the built packages it imports.
RUN npx tsc -b && npm run build -w @intentlink/extension
RUN test -f apps/extension/dist/manifest.json

# The store imports Firestore only when INTENTLINK_STORE=firestore, so local
# runs never need it; the deployed service does.
RUN npm install --no-save @google-cloud/firestore

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# Cloud Run supplies PORT; the server reads it.
CMD ["node", "apps/api/dist/server.js"]
