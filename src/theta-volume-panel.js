import { DEFAULT_MATH_SCHEMA_REGISTRY } from "./mathematical-schema-registry.js";
import { thetaVolumeGraphicalBoundary } from "./theta-volume-definition.js";

// This form binds existing faces to the category's generating boundary maps.
// Creation goes through the same semantic operation as agent and replay writes.
export function bindThetaVolumePanel({ workspace, modeHead, documentRef,
  operationOrigin = () => ({ source: "local-bus" }) }) {
  const tabbar = documentRef.querySelector("#golog-tabbar");
  if (!tabbar) return;
  const schema = DEFAULT_MATH_SCHEMA_REGISTRY.schemaForStructure("hierarchical-theta-space");
  const shapes = schema.objects.filter((shape) => shape.elementKind === "theta-volume");
  const button = documentRef.createElement("button");
  button.id = "theta-volume-open";
  button.type = "button";
  button.textContent = "Region";
  button.title = "Create a region from its boundary faces";
  tabbar.append(button);
  const dialog = documentRef.createElement("dialog");
  dialog.id = "theta-volume-dialog";
  dialog.className = "theta-volume-dialog";
  dialog.innerHTML = '<form><h2>Create a region</h2><label>Shape<select id="theta-volume-shape"></select></label><label>Name<input id="theta-volume-name" autocomplete="off"></label><div id="theta-volume-faces"></div><p id="theta-volume-error" role="alert"></p><div class="theta-volume-actions"><button type="button" id="theta-volume-cancel">Cancel</button><button type="submit" id="theta-volume-create">Create region</button></div></form>';
  documentRef.body.append(dialog);
  const shapeSelect = dialog.querySelector("#theta-volume-shape");
  const faceFields = dialog.querySelector("#theta-volume-faces");
  const error = dialog.querySelector("#theta-volume-error");
  const submit = dialog.querySelector("#theta-volume-create");
  let openedGologId = null;
  for (const shape of shapes) {
    const option = documentRef.createElement("option");
    option.value = shape.id;
    option.textContent = shape.notation;
    shapeSelect.append(option);
  }
  const active = () => workspace.gologs.get(workspace.activeGologId);
  const allowed = () => active()?.structure.id === "hierarchical-theta-space"
    && modeHead.canCreateSurface();
  function refreshMode() {
    button.hidden = !allowed();
    if (!allowed() && dialog.open) dialog.close();
  }
  function refreshFaces() {
    error.textContent = "";
    faceFields.replaceChildren();
    const state = active()?.state;
    const shape = shapes.find((entry) => entry.id === shapeSelect.value);
    const roles = shape?.thetaIndex === 8 ? ["First 2-cell", "Second 2-cell", "Composite 2-cell", "Source composition triangle", "Target composition triangle"] : null;
    for (const [index, face] of thetaVolumeGraphicalBoundary(shape?.id).entries()) {
      const label = documentRef.createElement("label");
      const source = schema.objects.find((entry) => entry.id === face.sourceObjectId);
      label.textContent = `${roles?.[index] ?? `Face ${index + 1}`} · ${source?.notation ?? "boundary"}`;
      const select = documentRef.createElement("select");
      select.dataset.faceId = face.id;
      select.required = true;
      const placeholder = documentRef.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose a boundary face";
      select.append(placeholder);
      for (const record of state?.objects.values() ?? []) {
        if (record.schemaRef?.objectId !== face.sourceObjectId) continue;
        const option = documentRef.createElement("option");
        option.value = record.id;
        option.textContent = record.name || record.label?.text || record.id;
        select.append(option);
      }
      label.append(select);
      faceFields.append(label);
    }
  }
  button.addEventListener("click", () => {
    if (!allowed()) return;
    openedGologId = workspace.activeGologId;
    refreshFaces();
    dialog.showModal();
  });
  shapeSelect.addEventListener("change", refreshFaces);
  dialog.querySelector("#theta-volume-cancel").addEventListener("click", () => dialog.close());
  dialog.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!allowed() || submit.disabled || openedGologId !== workspace.activeGologId) return;
    const state = active().state;
    const faces = Object.fromEntries([...faceFields.querySelectorAll("select")]
      .map((select) => [select.dataset.faceId, select.value]));
    error.textContent = "";
    try {
      submit.disabled = true;
      const result = await state.operationPipeline.submit("element:create", {
        elementKind: "theta-volume", shapeId: shapeSelect.value, faces,
        name: dialog.querySelector("#theta-volume-name").value,
      }, { origin: operationOrigin() });
      if (!result.ok) throw new Error(result.reason ?? "The boundary is not compatible.");
      dialog.close();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      submit.disabled = false;
    }
  });
  workspace.bus.on("workspace:active-changed", () => {
    if (dialog.open) dialog.close();
    refreshMode();
  });
  workspace.bus.on("mode:changed", refreshMode);
  refreshMode();
}
