import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MdNode = { type: string; value?: string; children?: MdNode[] };
type OpenLink = (url: string) => (event: React.MouseEvent) => void;

const BLOCK_PARENTS = new Set(['root', 'listItem', 'blockquote']);
const isWebUrl = (url: string | undefined): url is string => Boolean(url && /^https?:\/\//i.test(url));

/** Shows raw HTML as literal text instead of rendering or dropping it, so text like `ssh <user>@<host>` survives. */
const htmlAsText = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    node.children = node.children?.map(child => child.type !== 'html' ? child
      : BLOCK_PARENTS.has(node.type) ? { type: 'paragraph', children: [{ type: 'text', value: child.value }] }
      : { type: 'text', value: child.value });
    node.children?.forEach(walk);
  };
  walk(tree);
};

/** Renders assistant Markdown as React elements; web links open in the system browser and images become links. */
export function AssistantMarkdown({ text, openLink }: { text: string; openLink: OpenLink }) {
  const components: Components = {
    a: ({ href, children }) => isWebUrl(href) ? <a href={href} onClick={openLink(href)} title={href}>{children}</a> : <span>{children}</span>,
    img: ({ src, alt }) => typeof src === 'string' && isWebUrl(src) ? <a href={src} onClick={openLink(src)} title={src}>{alt || src}</a> : <span>{alt}</span>,
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>
  };
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm, htmlAsText]} components={components}>{text}</Markdown></div>;
}
