ARG BASE=ohif-ai-nifti-build-base:20260915
FROM ${BASE} AS builder
WORKDIR /usr/src/app
COPY Viewers/ ./
# Preserve the inherited, patched dependency tree; Yarn relinking would restore
# pristine Cornerstone files from its cache. Full builds use the normal recipe.
RUN ln -s ../../extensions/nifti node_modules/@ohif/extension-nifti \
    && ln -s ../../modes/nifti node_modules/@ohif/mode-nifti \
    && node -e "if(JSON.parse(require('fs').readFileSync('node_modules/fflate/package.json')).version!=='0.7.3')throw Error('fflate version mismatch')"
RUN node .scripts/install-stack-labelmap-update.js && node .scripts/install-interpolation-runtime.js && yarn run verify:cornerstone-stack-labelmap-patch
ENV APP_CONFIG=config/nifti.js
ARG NIFTI_STREAMING=false
RUN node -e "if(process.env.NIFTI_STREAMING==='true'){const fs=require('fs'),p='platform/app/public/config/nifti.js';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('enableNiftiStreaming: false','enableNiftiStreaming: true'))}"
RUN yarn run build
FROM nginx:alpine
COPY --from=builder /usr/src/app/platform/app/dist /var/www/html
CMD ["nginx", "-g", "daemon off;"]
