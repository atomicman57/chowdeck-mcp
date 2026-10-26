import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await build({entryPoints:[root+'hosting/worker.mjs'],outfile:root+'hosting/worker.bundle.mjs',bundle:true,platform:'browser',format:'esm',target:'es2022',mainFields:['module','main'],external:['node:*'],define:{'process.env.CHOWDECK_HTTP_ADAPTER':'"fetch"'},plugins:[{name:'hosted-session',setup(b){b.onResolve({filter:/\.\/session\.js$/},()=>({path:root+'hosting/session.mjs'}));}}]});
