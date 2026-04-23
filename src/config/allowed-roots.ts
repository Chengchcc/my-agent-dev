import { resolve } from 'path';

// Default allowed roots - current working directory and user home
const defaultRoots = [
  process.cwd(),
  resolve(require('os').homedir()),
];

export let allowedRoots = defaultRoots;

export function setAllowedRoots(newRoots: string[]) {
  allowedRoots = newRoots.map(root => resolve(root));
}
