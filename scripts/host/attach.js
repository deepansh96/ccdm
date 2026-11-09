"use strict";

// Clients attached to a ConPTY session. Each sees the screen at once and then a
// stream of {out} frames, ending in {exit}. Several may watch; among those that
// may resize, the last one to do so sets the size.
const { okResponse } = require("./protocol.js");

const MAX_DIMENSION = 1000;
// A client this far behind is disconnected rather than buffered without limit.
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024;

const validSize = size => Array.isArray(size) && size.length === 2
  && size.every(value => Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION);

function leave(viewer) {
  if (viewer.left) return;
  viewer.left = true;
  const { session, connection } = viewer;
  viewer.closeView?.();
  connection.abandons.delete(viewer.abandon);
  if (connection.stream === viewer.onFrame) connection.stream = null;
  session.viewers.splice(session.viewers.indexOf(viewer), 1);
  if (!viewer.size || session.exit !== null) return;
  const remaining = session.viewers.findLast(other => other.size);
  if (remaining) session.console.resize(...remaining.size);
  else session.console.resetSize();
}

function resize(viewer, size) {
  const { session } = viewer;
  viewer.size = size;
  // The end of the list is the last writer, which matters when this one leaves.
  session.viewers.splice(session.viewers.indexOf(viewer), 1);
  session.viewers.push(viewer);
  session.console.resize(...size);
}

function onStreamFrame(viewer, frame) {
  if (frame.detach === true) {
    leave(viewer);
    return;
  }
  if (viewer.readOnly || viewer.session.exit !== null) return;
  if (typeof frame.in === "string") viewer.session.console.send([frame.in], true);
  else if (validSize(frame.resize)) resize(viewer, frame.resize);
}

// Answers the request itself, so the reply is on the wire before the first {out}.
function attachSession(session, { id, readOnly, size }, connection) {
  return new Promise((resolve, reject) => {
    const viewer = { session, connection, readOnly: Boolean(readOnly), size: null, left: false, closeView: null };
    viewer.onFrame = frame => onStreamFrame(viewer, frame);
    viewer.abandon = () => leave(viewer);
    connection.abandons.add(viewer.abandon);
    session.viewers.push(viewer);
    const initialSize = !viewer.readOnly && validSize(size) ? size : null;
    try {
      viewer.closeView = session.console.view({
        size: initialSize,
        onStart(screen) {
          connection.send(okResponse(id, { ...screen, exit: session.exit }));
          if (session.exit !== null) {
            connection.send({ exit: session.exit });
            leave(viewer);
          } else {
            viewer.size = initialSize;
            connection.stream = viewer.onFrame;
          }
          resolve(null);
        },
        onOutput(data) {
          if (connection.socket.writableLength > MAX_BACKLOG_BYTES) connection.socket.destroy();
          else connection.send({ out: data });
        },
        onError(error) {
          leave(viewer);
          reject(error);
        },
      });
    } catch (error) {
      leave(viewer);
      reject(error);
    }
  });
}

// The session has ended: every attached client gets its {exit}.
function endViewers(session) {
  for (const viewer of [...session.viewers]) {
    viewer.connection.send({ exit: session.exit });
    leave(viewer);
  }
}

module.exports = { attachSession, endViewers };
