// Vitest resolves `import "server-only"` to this empty module. Inside Next.js the
// import is handled by the framework and fails the build when a client component
// imports a server file.
export {};
