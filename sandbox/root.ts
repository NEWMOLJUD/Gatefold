// Script da página /root/setup. A senha root fica só na memória desta aba e
// segue em cada chamada à API; nada é gravado no navegador.
export const ROOT_SCRIPT = String.raw`"use strict";
(function () {
  var password = "";
  var ask = document.getElementById("ask");
  var panel = document.getElementById("panel");
  var message = document.getElementById("message");
  var table = document.getElementById("admins");

  function say(text, kind) {
    message.textContent = text;
    message.className = "note " + (kind || "");
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
        var error = new Error(data.error || "Erro " + response.status);
        error.status = response.status;
        throw error;
      });
    });
  }

  function failed(error) {
    say(error.message, "bad");
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
        cell(row, admin.username);
        cell(row, new Date(admin.created_at).toISOString().slice(0, 16).replace("T", " "));
        var button = document.createElement("button");
        button.className = "danger";
        button.textContent = "Remover";
        button.addEventListener("click", function () {
          if (!confirm("Remover o administrador " + admin.username + "?")) return;
          call("DELETE", "/api/root/admins/" + encodeURIComponent(admin.id))
            .then(function () { say("Administrador removido.", "ok"); return load(); })
            .catch(failed);
        });
        cell(row, "").appendChild(button);
        table.appendChild(row);
      });
      if (data.items.length === 0) cell(table.appendChild(document.createElement("tr")), "Nenhum administrador ainda.");
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
        say("Administrador criado. Ele já pode entrar em /admin/.", "ok");
        return load();
      })
      .catch(failed);
  });

  ask.showModal();
})();
`;
