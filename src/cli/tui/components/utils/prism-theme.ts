// Side-effect imports — registers languages with Prism globally
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-diff';

export const prismTheme: Record<string, string> = {
  comment: 'gray',
  prolog: 'gray',
  doctype: 'gray',
  cdata: 'gray',
  punctuation: 'gray',
  property: 'cyan',
  keyword: 'blue',
  boolean: 'yellow',
  number: 'yellow',
  constant: 'cyan',
  symbol: 'green',
  selector: 'green',
  'attr-name': 'green',
  string: 'green',
  builtin: 'cyan',
  inserted: 'green',
  operator: 'gray',
  entity: 'white',
  url: 'cyan',
  variable: 'white',
  atrule: 'yellow',
  'attr-value': 'yellow',
  placeholder: 'yellow',
  deleted: 'red',
  italic: 'italic',
  important: 'bold',
  bold: 'bold',
  heading: 'blue',
  function: 'blue',
  'class-name': 'yellow',
  'tag': 'blue',
};

export function getPrismTokenColor(type: string | null): string {
  return type ? (prismTheme[type] ?? 'white') : 'white';
}
