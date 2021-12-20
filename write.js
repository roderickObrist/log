"use strict";

const canHandleColors = process.stdout.isTTY,
  r = require("rethinkdb"),
  noop = () => {};

require("colors");

let store = async data => {
  let conn = null;

  store = data => store.buffer.push(data);
  store.buffer = [data];

  try {
    conn = await r.connect("192.168.1.15");
  } catch (e) {
    store = noop;
    throw e;
  }

  let state = "connected";

  async function insert(data, secondAttempt = false) {
    try {
      const date = new Date().toJSON().slice(0, 10).replace(/-/g, "_"),
        query = r.db("log")
          .table(date)
          .insert(data);

      await query.run(conn, {
        "durability": "soft"
      });
    } catch (e) {
      if (secondAttempt) {
        console.error(data);
        throw e;
      }

      // This is what happens during circular references
      if (e instanceof r.Error.ReqlCompileError) {
        for (const d of [].concat(data)) {
          d.body = JSON.parse(JSON.stringify(d.body));

          const messageKey = d.body.code
            ? "retryCode"
            : "code";

          d.level = "warn";
          d.body[messageKey] = e.message;
        }

        insert(data, true);
        return;
      }

      // This is what happens when a string is really long and rethink craps it
      if (e.message === "Cannot read property 'length' of undefined") {
        for (const d of [].concat(data)) {
          d.body = JSON.parse(JSON.stringify(d.body, (key, value) => {
            return (typeof value === "string" && value.length > 1e3)
              ? value.slice(0, 1e3) + "...TRUNCATED"
              : value;
          }));

          const messageKey = d.body.code
            ? "retryCode"
            : "code";

          d.level = "warn";
          d.body[messageKey] = e.message;
        }

        insert(data, true);
        return;
      }

      throw e;
    }
  }

  // Empty the buffer
  if (store.buffer.length) {
    insert(store.buffer);
  }

  // Overwrite store
  store = insert;

  conn
    .on("close", () => {
      store = noop;

      if (state === "connecting") {
        return;
      }

      state = "connecting";

      (async function connect() {
        try {
          await conn.reconnect();
        } catch (err) {
          setTimeout(connect, 1e3);
        }
      })();
    })
    .on("connect", () => {
      state = "connected";
      store = insert;
    })
    .on("timeout", () => {
      store = noop;
    })
    .on("error", () => {
      store = noop;
    });
};

function print(data, stringified) {
  const t = new Date(),
    maxStrLen = canHandleColors
      ? process.stdout.columns - 19
      : 200,
    stringifiedCapped = stringified.length > maxStrLen
      ? stringified.slice(0, maxStrLen)
      : stringified;

  if (["error", "warn"].includes(data.level)) {
    const severity = data.level === "error"
      ? "red"
      : "yellow";

    if (canHandleColors) {
      console.error(`${(data.body.code || data.path).bold[severity]} ${stringified}`);
    } else {
      console.error(`${data.path} ${stringified}`);
    }

    return;
  }

  if (canHandleColors) {
    const time = t.toTimeString().substr(0, 8),
      directionColour = data.direction === "IN"
        ? "red"
        : "green",
      protoDirection = data.protocol.bold[directionColour],
      connection = data.connectionId.slice(-3).blue;

    console.log(`${time} ${protoDirection}[${connection}]: ${stringifiedCapped}`);
    return;
  }

  const time = `${t.getDate()} ${t.toDateString().substr(4, 3)} ${t.toTimeString().substr(0, 8)}`,
    protoConnectionDirection = `${data.protocol}: [${data.connectionId}] ${data.direction}`;

  console.log(`${time} - ${protoConnectionDirection}: ${stringifiedCapped}`);
}

module.exports = (data, stringified = JSON.stringify(data.body)) => {
  store(data);

  print(data, stringified);
};