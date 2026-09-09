const required = { node: '24.14.0', npm: '11.9.0' };
const npmVersion = process.env.npm_config_user_agent?.match(/^npm\/([^ ]+)/)?.[1];
if (process.versions.node !== required.node || (npmVersion && npmVersion !== required.npm)) {
  console.error(`SETUP_REQUIRED: use Node ${required.node} (.node-version/.nvmrc) and npm ${required.npm}, then run npm ci. No product process was started.`);
  process.exitCode = 1;
} else {
  console.log(`Toolchain: Node ${process.versions.node}; npm ${npmVersion ?? 'not invoked by npm (verify npm --version)'}`);
}
