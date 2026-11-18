"use strict";

// Connections that asked to hear when a session ends.
const { okResponse } = require("./protocol.js");

function createEvents() {
  const subscribers = new Set();
  return {
    // Answers the request itself, so the reply always comes before the first event.
    subscribe(connection, id) {
      connection.send(okResponse(id));
      subscribers.add(connection);
      connection.abandons.add(() => subscribers.delete(connection));
    },
    sessionEnded(name, code) {
      for (const connection of subscribers) connection.send({ event: "exit", name, code });
    },
  };
}

module.exports = { createEvents };
