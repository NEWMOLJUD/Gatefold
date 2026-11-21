// Script of the folder upload on /admin/edit-source. The browser reads the
// folder the administrator chose and sends its files one by one to the same
// API a script would call: PUT /api/admin/sources/<alias>/files/<path>.
import { fingerprint } from "./styles.ts";

export const UPLOAD_SCRIPT = String.raw`"use strict";
(function () {
  var form = document.getElementById("upload");
  if (!form) return;
  var input = document.getElementById("folder");
  var mirror = document.getElementById("mirror");
  var button = form.querySelector("button");
  var status = document.getElementById("upload-status");
  var bar = document.getElementById("upload-progress");
  var count = document.getElementById("upload-count");
  var message = document.getElementById("upload-message");
  var log = document.getElementById("upload-log");
  var alias = form.getAttribute("data-alias");
  var maximum = Number(form.getAttribute("data-max"));
  var base = "/api/admin/sources/" + encodeURIComponent(alias) + "/files";
  var PARALLEL = 4;

  function say(text, kind) {
    message.textContent = text;
    message.className = "alert alert-" + (kind || "info");
    message.hidden = !text;
  }

  function note(text) {
    var item = document.createElement("li");
    item.textContent = text;
    log.appendChild(item);
    log.hidden = false;
  }

  function address(path) {
    return base + "/" + path.split("/").map(encodeURIComponent).join("/");
  }

  function call(method, url, body) {
    return fetch(url, { method: method, body: body, credentials: "same-origin" }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.ok) return data;
        throw new Error(data.error || "Error " + response.status);
      });
    });
  }

  // The path of a file inside the source: the name of the chosen folder itself is left out.
  function inside(file) {
    var parts = (file.webkitRelativePath || file.name).split("/");
    if (parts.length > 1) parts.shift();
    return parts;
  }

  // Runs the worker over the items, a few at a time. The worker never fails: it writes its own errors down.
  function each(items, worker) {
    var next = 0;
    function step() {
      if (next >= items.length) return Promise.resolve();
      return worker(items[next++]).then(step);
    }
    var lanes = [];
    for (var i = 0; i < PARALLEL; i++) lanes.push(step());
    return Promise.all(lanes);
  }

  // Every path the source holds, a thousand at a time.
  function stored(after, found) {
    return call("GET", base + "?limit=1000" + (after ? "&after=" + encodeURIComponent(after) : "")).then(function (page) {
      for (var i = 0; i < page.items.length; i++) found.push(page.items[i].path);
      return page.next_after ? stored(page.next_after, found) : found;
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var sending = [];
    var skipped = 0;
    var failed = 0;
    var done = 0;
    log.textContent = "";
    log.hidden = true;
    for (var i = 0; i < input.files.length; i++) {
      var parts = inside(input.files[i]);
      // Hidden files and folders (.git, .DS_Store) are not part of a site, and the server refuses them.
      if (parts.some(function (part) { return part === "" || part.charAt(0) === "."; })) skipped++;
      else sending.push({ path: parts.join("/"), file: input.files[i] });
    }
    if (sending.length === 0) return say("Choose a folder with at least one file that is not hidden.", "danger");

    button.disabled = true;
    input.disabled = true;
    status.hidden = false;
    bar.max = sending.length;
    bar.value = 0;
    say("Uploading. Keep this page open until it finishes.", "info");

    function progress() {
      bar.value = done;
      count.textContent = done + " of " + sending.length + " files" + (failed ? ", " + failed + " failed" : "");
    }
    progress();

    each(sending, function (item) {
      var sent = item.file.size > maximum
        ? Promise.reject(new Error("The file is too large: the maximum is " + Math.round(maximum / 1048576) + " MB."))
        : call("PUT", address(item.path), item.file);
      return sent.catch(function (error) {
        failed++;
        note(item.path + ": " + error.message);
      }).then(function () {
        done++;
        progress();
      });
    }).then(function () {
      if (failed || !mirror.checked) return 0;
      var kept = {};
      for (var i = 0; i < sending.length; i++) kept[sending[i].path] = true;
      return stored("", []).then(function (paths) {
        var extra = paths.filter(function (path) { return !kept[path]; });
        say("Removing " + extra.length + " files that are not in the folder.", "info");
        return each(extra, function (path) {
          return call("DELETE", address(path)).catch(function (error) {
            failed++;
            note(path + ": " + error.message);
          });
        }).then(function () { return extra.length; });
      });
    }).catch(function (error) {
      failed++;
      note(error.message);
      return 0;
    }).then(function (removed) {
      if (failed) {
        button.disabled = false;
        input.disabled = false;
        return say(failed + " of the steps failed: see the list below. What did go through is already published. Upload the folder again to retry.", "danger");
      }
      var text = sending.length + " files uploaded" + (removed ? ", " + removed + " removed" : "") + (skipped ? ", " + skipped + " hidden files left out" : "") + ".";
      window.location.href = window.location.pathname + "?source=" + encodeURIComponent(alias) + "&ok=" + encodeURIComponent(text);
    });
  });
})();
`;

/** The address of the script. It carries a fingerprint, so browsers can keep it for good. */
export const UPLOAD_PATH = "/assets/upload.js";
export const UPLOAD_HREF = `${UPLOAD_PATH}?v=${fingerprint(UPLOAD_SCRIPT)}`;
