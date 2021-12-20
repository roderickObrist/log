"use strict";

const write = require("./write"),
  r = require("rethinkdb"),
  os = require("os");

require("colors");

function makeBase(level, {connectionId = "", direction = "OUT", protocol = level, path = "", body = {}}) {
  const base = {
    level,
    connectionId,
    direction,
    protocol,
    path,
    body,
    "timestamp": r.now(),
    "server": os.hostname()
  };

  if (base.body === undefined) {
    base.body = "undefined";
  }

  return base;
}

function safeStringify(base, format = null) {
  let stringified = "";

  try {
    stringified = JSON.stringify(base.body, null, format);
  } catch (e) {
    if (!e.message.includes("circular structure")) {
      throw e;
    }

    const map = new Map();

    stringified = JSON.stringify(base.body, (key, value) => {
      if (!(value instanceof Object)) {
        return value;
      }

      if (typeof value === "function") {
        return `${value.constructor.name} ${value.name}()`;
      }

      if (map.has(value)) {
        return map.get(value);
      }

      map.set(value, `[Circular->${key}]`);

      return value;
    }, format);

    base.body = JSON.parse(stringified);
  }

  return stringified;
}

function isBase(obj) {
  return obj &&
    ["connectionId", "direction", "protocol", "path"].some(key => Object.hasOwnProperty.call(obj, key));
}

function formatMultipleArgs(all, level) {
  let errorObject = all.find(item => item instanceof Error),
    baseObject = all.find(isBase) || {},
    {
      direction = "IN",
      protocol = "ERR",
      path = ""
    } = baseObject;

  const {connectionId = "", body = {}} = baseObject;

  if (!Object.keys(baseObject).length) {
    baseObject = null;
  }

  if (errorObject) {
    all.splice(all.indexOf(errorObject), 1);
  } else {
    errorObject = new Error();
  }

  if (baseObject) {
    all.splice(all.indexOf(baseObject), 1);
  }

  all.filter(value => typeof value === "string")
    .forEach(value => {
      const i = all.indexOf(value);

      all.splice(i, 1);

      if (
        is(value, "IN", "OUT")
      ) {
        direction = value;
      } else if (errorObject.message === "") {
        errorObject.message = value;
      } else if (
        value.length < 5 &&
          value.toUpperCase() === value
      ) {
        protocol = value;
      } else if (
        !path &&
          /[:/]/.test(value)
      ) {
        path = value;
      } else {
        if (!body.strings) {
          body.strings = [];
        }

        body.strings.push(value);
      }
    });

  body.stack = errorObject.stack.split("\n")
    .filter((line, i) => i && !line.includes(__filename))
    .map(line => line.trim());

  ["query", "param", "formatted"].forEach(key => {
    if (errorObject[key]) {
      body[key] = errorObject[key];
    }
  });

  if (!body.code) {
    body.code = String(errorObject.code || errorObject.message || path);
  }

  if (all.length === 1) {
    if (baseObject) {
      [body.extra] = all;
    } else {
      Object.assign(body, all[0]);
    }
  } else {
    all.forEach((value, i) => {
      body[i] = value;
    });
  }

  if (!errorObject.message) {
    errorObject.message = body.code;
  }

  errorObject[Symbol.for("logged")] = true;

  return [makeBase(level, {
    connectionId,
    direction,
    protocol,
    path,
    body
  }), errorObject];
}

function isBaseObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

exports.info = (data, optionalStringified) => {
  const base = makeBase("info", data),
    stringified = optionalStringified || safeStringify(base);

  if (stringified.length > 512 * 1024) {
    if (isBaseObject(base.body)) {
      for (const [key, value] of Object.entries(base.body)) {
        base.body[key] = isBaseObject(value)
          ? "TRUNCATED"
          : value;
      }
    } else {
      base.body = "TRUNCATED";
    }
  }

  write(base, stringified);
};

exports.dump = (...all) => {
  const base = makeBase("info", {
    "protocol": "DUMP",
    "path": "debug-var",
    "body": all.length > 1
      ? all
      : all[0]
  });

  exports.info(base, safeStringify(base));
};

exports.warn = (...all) => {
  const [base, err] = formatMultipleArgs(all, "warn");

  write(base, safeStringify(base, 2));

  return err;
};

exports.error = (...all) => {
  const [base, err] = formatMultipleArgs(all, "error");

  write(base, safeStringify(base, 2));

  return err;
};

exports.session = (details, stringified) => {
  const {
    connectionId = Math.random()
      .toString(36)
      .slice(-8),
    direction = "OUT",
    protocol = "INFO",
    path = "none",
    body = {}
  } = details;

  exports.info({
    connectionId,
    direction,
    protocol,
    path,
    body
  }, stringified);

  const nextDirection = direction === "OUT"
    ? "IN"
    : "OUT";

  return {
    connectionId,
    info(nextBody, nextStringified) {
      exports.info({
        connectionId,
        protocol,
        path,
        "body": nextBody,
        "direction": nextDirection
      }, nextStringified);
    },
    warn(...all) {
      exports.warn({
        connectionId,
        protocol,
        path,
        "direction": nextDirection
      }, ...all);
    },
    error(...all) {
      exports.error({
        connectionId,
        protocol,
        path,
        "direction": nextDirection
      }, ...all);
    }
  };
};


setTimeout(() => {
  exports.session({
    "protocol": "data",
    "direction": "IN",
    "path": "request",
    "body": "hello world"
  })
}, 50)