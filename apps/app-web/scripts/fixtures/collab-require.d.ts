declare module 'collab-require-probe' {
  const required: {
    Doc: typeof import('yjs').Doc;
    DecorationSet: typeof import('@tiptap/pm/view').DecorationSet;
    Node: typeof import('@tiptap/pm/model').Node;
  };
  export default required;
}
