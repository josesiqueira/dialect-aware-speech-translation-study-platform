// Runs in the browser before any other application code (Next.js file
// convention, see node_modules/next/dist/docs: instrumentation-client).
//
// Zod 4 speeds up object schemas by compiling code with `new Function`, and
// first tests whether that is allowed with `new Function("")` inside try and
// catch. The production Content Security Policy has no 'unsafe-eval', so the
// browser blocks the test and reports a violation on every page, although
// nothing is loaded or run. `jitless: true` is the documented Zod setting for
// such environments: Zod skips the test and uses its ordinary parser.
//
// It must be set before the first object schema is created, which is why it is
// here and not in a component. It applies to browser code only. The server is
// not under the Content Security Policy and keeps the default.
import { config } from "zod";

config({ jitless: true });
