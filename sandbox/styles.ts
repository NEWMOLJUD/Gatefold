// The built-in script of the system pages, served from /assets/. The design
// (stylesheets, colours, logo) is not code: it lives in sites/label/.

/** Progressive enhancement only: every page works without it. */
export const APP_JS = String.raw`"use strict";
(function () {
  document.addEventListener("submit", function (event) {
    var form = event.target;
    var question = form.getAttribute("data-confirm");
    if (question && !window.confirm(question)) return event.preventDefault();
    var areas = form.querySelectorAll("textarea[data-json]");
    for (var i = 0; i < areas.length; i++) {
      try {
        JSON.parse(areas[i].value.trim() === "" ? "{}" : areas[i].value);
        areas[i].setCustomValidity("");
      } catch (error) {
        event.preventDefault();
        areas[i].setCustomValidity("This is not valid JSON. " + error.message);
        areas[i].reportValidity();
        return;
      }
    }
  });

  document.addEventListener("input", function (event) {
    if (event.target.matches && event.target.matches("textarea[data-json]")) event.target.setCustomValidity("");
  });

  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("[data-copy]") : null;
    if (!button || !navigator.clipboard) return;
    var source = document.querySelector(button.getAttribute("data-copy"));
    if (!source) return;
    navigator.clipboard.writeText(source.textContent).then(function () {
      button.textContent = "Copied";
    });
  });
})();
`;

/** Short fingerprint of a text, used as `?v=` so browsers can cache it for good. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
