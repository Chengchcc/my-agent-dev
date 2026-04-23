import { resolve } from 'path';

// Default allowed roots - only current working directory for security
// This prevents access to sensitive files outside the project like ~/.ssh, ~/.aws, etc.
const defaultRoots = [
  process.cwd(),
];

export let allowedRoots = defaultRoots;

export function setAllowedRoots(newRoots: string[]) {
  allowedRoots = newRoots.map(root => resolve(root));
}
