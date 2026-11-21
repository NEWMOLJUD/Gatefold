// Script of the /root/setup page. The root password stays only in the memory
// of this tab and goes along with each API call; nothing is stored in the browser.
export const ROOT_SCRIPT = String.raw`"use strict";
(function () {
  var password = "";
  var ask = document.getElementById("ask");
  var panel = document.getElementById("panel");
  var message = document.getElementById("message");
  var table = document.getElementById("admins");

  function say(text, kind) {
    message.textContent = text;
    message.className = "alert alert-" + (kind || "info");
    message.hidden = !text;
  }

  function call(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { "x-root-password": password, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.ok) return data;
        var error = new Error(data.error || "Error " + response.status);
        error.status = response.status;
        throw error;
      });
    });
  }

  function failed(error) {
    say(error.message, "danger");
    if (error.status === 401 || error.status === 429) {
      panel.hidden = true;
      if (error.status === 401) ask.showModal();
    }
  }

  function cell(row, text) {
    var td = document.createElement("td");
    td.textContent = text;
    row.appendChild(td);
    return td;
  }

  function load() {
    return call("GET", "/api/root/admins").then(function (data) {
      panel.hidden = false;
      table.textContent = "";
      data.items.forEach(function (admin) {
        var row = document.createElement("tr");
        cell(row, admin.username + (admin.suspended ? " (suspended)" : "") + (admin.two_step ? " (two-step verification)" : ""));
        cell(row, new Date(admin.created_at).toISOString().slice(0, 16).replace("T", " "));
        var button = document.createElement("button");
        button.className = "btn btn-danger btn-sm";
        button.textContent = "Remove";
        button.addEventListener("click", function () {
          if (!confirm("Remove the administrator " + admin.username + "?")) return;
          call("DELETE", "/api/root/admins/" + encodeURIComponent(admin.id))
            .then(function () { say("Administrator removed.", "ok"); return load(); })
            .catch(failed);
        });
        var actions = cell(row, "");
        actions.className = "end";
        if (admin.suspended) {
          var back = document.createElement("button");
          back.className = "btn btn-sm";
          back.textContent = "Reactivate";
          back.addEventListener("click", function () {
            call("POST", "/api/root/admins/" + encodeURIComponent(admin.id) + "/reactivate")
              .then(function () { say("Administrator reactivated.", "ok"); return load(); })
              .catch(failed);
          });
          actions.appendChild(back);
        }
        var reset = document.createElement("button");
        reset.className = "btn btn-sm";
        reset.textContent = "Set password";
        reset.addEventListener("click", function () {
          var secret = prompt("New password for " + admin.username + " (it is shown as you type):");
          if (!secret) return;
          call("PUT", "/api/root/admins/" + encodeURIComponent(admin.id), { password: secret })
            .then(function () { say("Password of " + admin.username + " changed. Their sessions were signed out.", "ok"); })
            .catch(failed);
        });
        actions.appendChild(reset);
        if (admin.two_step) {
          var twoStep = document.createElement("button");
          twoStep.className = "btn btn-sm";
          twoStep.textContent = "Turn off two-step";
          twoStep.addEventListener("click", function () {
            if (!confirm("Turn off two-step verification for " + admin.username + "? They will sign in with the password alone.")) return;
            call("DELETE", "/api/root/admins/" + encodeURIComponent(admin.id) + "/two-step")
              .then(function () { say("Two-step verification of " + admin.username + " turned off.", "ok"); return load(); })
              .catch(failed);
          });
          actions.appendChild(twoStep);
        }
        actions.appendChild(button);
        table.appendChild(row);
      });
      if (data.items.length === 0) cell(table.appendChild(document.createElement("tr")), "No administrators yet. Create the first one above.");
      return call("GET", "/api/root/settings");
    }).then(function (settings) {
      document.getElementById("retention").value = settings.audit_retention_days;
    });
  }

  ask.addEventListener("close", function () {
    password = document.getElementById("root-password").value;
    document.getElementById("root-password").value = "";
    if (!password) return ask.showModal();
    say("", "");
    load().catch(failed);
  });

  document.getElementById("create").addEventListener("submit", function (event) {
    event.preventDefault();
    var username = document.getElementById("username");
    var secret = document.getElementById("password");
    call("POST", "/api/root/admins", { username: username.value, password: secret.value })
      .then(function () {
        username.value = "";
        secret.value = "";
        say("Administrator created. They can now sign in at /admin/.", "ok");
        return load();
      })
      .catch(failed);
  });

  document.getElementById("policy").addEventListener("submit", function (event) {
    event.preventDefault();
    call("PUT", "/api/root/settings", { audit_retention_days: Number(document.getElementById("retention").value) })
      .then(function (settings) { say("Policy saved: audit entries are kept for " + settings.audit_retention_days + " days.", "ok"); })
      .catch(failed);
  });

  ask.showModal();
})();
`;
