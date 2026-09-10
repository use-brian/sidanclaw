// Deliberately exercise require as well as import through the browser bundler.
module.exports = {
  Doc: require('yjs').Doc,
  DecorationSet: require('@tiptap/pm/view').DecorationSet,
  Node: require('@tiptap/pm/model').Node,
};
