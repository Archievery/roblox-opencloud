// Runs publint and attw with npm's dry-run flag stripped from the environment. Under
// `npm publish --dry-run` npm exports npm_config_dry_run=true, attw's nested `npm pack` inherits
// it and writes no tarball, and attw then fails to read one.
import { execSync } from "node:child_process";

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_dry_run$/i.test(key)));

execSync("npx publint", { stdio: "inherit", env });
execSync("npx attw --pack .", { stdio: "inherit", env });
