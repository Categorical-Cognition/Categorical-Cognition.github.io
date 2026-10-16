export const VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID = "virtual-double-category";
export const VIRTUAL_DOUBLE_CATEGORY_SCHEMA_ID =
  "virtual-double-category.presentation.v1";

export const VIRTUAL_DOUBLE_ELEMENT_KINDS = Object.freeze({
  OBJECT: "virtual-double-object",
  TIGHT_ARROW: "virtual-double-tight-arrow",
  PROARROW: "virtual-double-proarrow",
  CELL: "virtual-double-cell",
});

export const VIRTUAL_DOUBLE_CATEGORY_SCHEMA = Object.freeze({
  format: "golog.math-schema",
  version: 1,
  id: VIRTUAL_DOUBLE_CATEGORY_SCHEMA_ID,
  structureId: VIRTUAL_DOUBLE_CATEGORY_STRUCTURE_ID,
  title: "Virtual Double Category",
  aliases: {
    "virtual-object": VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT,
    "tight-arrow": VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW,
    "ordinary-arrow": VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW,
    proarrow: VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW,
    "virtual-arrow": VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW,
    "virtual-cell": VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL,
  },
  objects: [
    {
      id: "virtual-double:object",
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.OBJECT,
      dimension: 0,
      renderKind: "sphere",
    },
    {
      id: "virtual-double:tight-arrow",
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.TIGHT_ARROW,
      dimension: 1,
      renderKind: "edge",
      boundaryKind: "endpoints",
    },
    {
      id: "virtual-double:proarrow",
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.PROARROW,
      dimension: 1,
      renderKind: "marked-edge",
      boundaryKind: "endpoints",
    },
    {
      id: "virtual-double:cell",
      elementKind: VIRTUAL_DOUBLE_ELEMENT_KINDS.CELL,
      dimension: 2,
      renderKind: "membrane",
      boundaryKind: "virtual-double-cell-boundary",
    },
  ],
});
