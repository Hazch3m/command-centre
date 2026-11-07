#!/bin/sh
# The real worker, with Cloudflare's runtime swapped for local stand-ins.
set -e
cd "$(dirname "$0")"
R=$(cd ../.. && pwd)
S=$R/cloud/src
sed -e 's#from "cloudflare:workers"#from "./mock"#' \
    -e 's#^import initSqlJs, { type SqlJsStatic } from "sql.js";#import initSqlJs from "./sqlshim"; type SqlJsStatic = any;#' \
    -e 's#from "../../src/core/account"#from "'$R'/src/core/account"#' \
    -e '/^import wasmModule/d' \
    -e 's#from "./appBackend"#from "'$S'/appBackend"#' \
    -e 's#from "./cloudSync"#from "'$S'/cloudSync"#' \
    -e 's#from "./apple"#from "./fakeapple"#' \
    -e 's#from "../../src/core/sync"#from "'$R'/src/core/sync"#' \
    $S/worker.ts > worker-shim.ts
python3 - <<'PY'
import re
s=open('worker-shim.ts').read()
s=re.sub(r'const sqlJs = \(\) =>\n  \(SQL \?\?= initSqlJs\(\{.*?\}\) as Promise<SqlJsStatic>\);', 'const sqlJs = () => (SQL ??= initSqlJs() as any);', s, flags=re.S)
s=s.replace('return env.ASSETS.fetch(req);','return new Response("not found", { status: 404 });')
open('worker-shim.ts','w').write(s)
PY
cat > tsconfig.json <<J
{"compilerOptions": {"target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "jsx": "react-jsx", "resolveJsonModule": true, "allowImportingTsExtensions": true, "baseUrl": ".", "paths": {"@backend": ["$S/appBackend.ts"], "react": ["./reactstub.ts"], "react/jsx-runtime": ["./reactstub.ts"]}}}
J
grep -c sqlJs worker-shim.ts
