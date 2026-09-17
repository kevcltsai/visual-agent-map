var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// main.ts
var main_exports = {};
__export(main_exports, {
  VisualAgentMapView: () => VisualAgentMapView,
  buildPreparedTaskContext: () => buildPreparedTaskContext,
  canonicalDetail: () => canonicalDetail,
  default: () => VisualAgentMapPlugin,
  firstMarkdownImage: () => firstMarkdownImage,
  firstMarkdownTable: () => firstMarkdownTable,
  markdownImages: () => markdownImages,
  visualReferencesMarkdown: () => visualReferencesMarkdown
});
module.exports = __toCommonJS(main_exports);

// i18n.ts
var english = {
  "\u4ECB\u9762\u8A9E\u8A00": "Interface language",
  "\u5F85\u7814\u7A76": "To research",
  "AI \u57F7\u884C\u4E2D": "AI running",
  "AI \u5B8C\u6210": "AI complete",
  "\u57F7\u884C\u932F\u8AA4": "Task error",
  "\u53D6\u6D88": "Cancel",
  "\u5132\u5B58": "Save",
  "\u9078\u64C7": "Select",
  "\u81EA\u8A02 AI \u4EFB\u52D9": "Custom AI task",
  "\u63CF\u8FF0\u9019\u4E00\u6B65\u8981\u8ACB AI \u5B8C\u6210\u4EC0\u9EBC\u3002": "Describe what you want AI to do next.",
  "\u672C\u6B21\u5957\u7528\u7684 AI \u898F\u5247": "AI rules for this task",
  "\u672A\u8A2D\u5B9A\u984D\u5916\u898F\u5247\u3002": "No additional rules.",
  "\u53EA\u5132\u5B58": "Save only",
  "\u78BA\u8A8D\u4E26\u57F7\u884C": "Confirm and run",
  "AI \u5B50\u8B70\u984C\u63D0\u6848": "AI subtopic proposals",
  "\u52FE\u9078\u8981\u5EFA\u7ACB\u7684\u5B50\u8B70\u984C\uFF1B\u5EFA\u7ACB\u524D\u53EF\u76F4\u63A5\u4FEE\u6539\u540D\u7A31\u8207\u4EFB\u52D9\u3002": "Select subtopics to create. You can edit their names and tasks first.",
  "\u5C0D\u6BCD\u8B70\u984C\u7684\u8CA2\u737B": "Contribution to the parent topic",
  "\u5EFA\u7ACB\u5B50\u8B70\u984C": "Create subtopics",
  "\u78BA\u8A8D\u6574\u5408\u8B70\u984C": "Confirm topic synthesis",
  "\u4F86\u6E90\u8B70\u984C": "Source topics",
  "\u65B0\u8B70\u984C\u540D\u7A31": "New topic name",
  "\u6574\u5408\u8B70\u984C": "Synthesize topics",
  "\u6574\u5408\u76EE\u6A19": "Synthesis goal",
  "\u627E\u51FA\u5171\u540C\u7D50\u8AD6\u3001\u91CD\u8981\u5DEE\u7570\u3001\u53D6\u6368\u8207\u4E0B\u4E00\u6B65\u3002": "Identify shared conclusions, key differences, tradeoffs and next steps.",
  "AI \u898F\u5247": "AI rules",
  "\u756B\u9762\u8207 Markdown \u90FD\u6709\u4FEE\u6539\u3002\u8ACB\u9078\u64C7\u8981\u4FDD\u7559\u7684\u5167\u5BB9\uFF0C\u6216\u5728\u4E0B\u65B9\u624B\u52D5\u5408\u4F75\u3002": "Both the editor and Markdown have changed. Choose a version or merge below.",
  "\u4F7F\u7528\u6A94\u6848\u5167\u5BB9": "Use file contents",
  "\u4FDD\u7559\u756B\u9762\u5167\u5BB9": "Keep editor contents",
  "\u5132\u5B58\u5408\u4F75\u5167\u5BB9": "Save merged contents",
  "\u5FC3\u667A\u5716\u6709\u5916\u90E8\u4FEE\u6539": "Mind map changed externally",
  "\u756B\u9762\u8207 Map.md \u7684\u7D50\u69CB\u90FD\u5DF2\u6539\u8B8A\u3002\u53EF\u9078\u64C7\u5176\u4E2D\u4E00\u7248\uFF0C\u6216\u7DE8\u8F2F\u4E0B\u65B9 JSON \u5F8C\u624B\u52D5\u5408\u4F75\u3002": "Both the map and Map.md have changed. Choose a version or edit the JSON below to merge.",
  "\u5408\u4F75\u5167\u5BB9\u7121\u6548\u3002": "Invalid merged contents.",
  "\u76EE\u524D\u6C92\u6709\u7B46\u8A18\u3002": "No notes yet.",
  "\u95DC\u9589": "Close",
  "\u6C92\u6709\u5176\u4ED6\u4E3B\u984C\u3002": "No other topics.",
  "\u627E\u4E0D\u5230\u8981\u91CD\u65B0\u9023\u7D50\u7684\u7BC0\u9EDE\u3002": "The node to relink was not found.",
  "\u91CD\u65B0\u547D\u540D\u76EE\u524D\u5FC3\u667A\u5716": "Rename current mind map",
  "\u540C\u6642\u66F4\u65B0\u4E3B\u984C\u8CC7\u6599\u593E\u8207\u5FC3\u667A\u5716\u540D\u7A31\u3002": "Update the topic folder and mind map name together.",
  "\u6574\u7406\u820A\u8CC7\u6599": "Migrate old data",
  "\u9810\u89BD\u5F8C\u628A\u820A\u7248\u5FC3\u667A\u5716\u6574\u7406\u6210\u76EE\u524D\u7684\u4E3B\u984C\u7D50\u69CB\u3002": "Preview and migrate old maps into the current topic structure.",
  "\u4FEE\u5FA9\u907A\u5931\u7684\u5FC3\u667A\u5716": "Repair missing mind map",
  "\u5F9E\u73FE\u6709\u8B70\u984C\u7B46\u8A18\u91CD\u65B0\u5EFA\u7ACB\u7F3A\u5C11\u7684 Map\u3002": "Rebuild a missing map from existing topic notes.",
  "\u522A\u9664\u76EE\u524D\u5FC3\u667A\u5716": "Delete current mind map",
  "\u53EA\u79FB\u9664\u5FC3\u667A\u5716\u6A94\u6848\uFF0C\u4FDD\u7559\u6240\u6709\u8B70\u984C\u7B46\u8A18\uFF0C\u4E26\u53EF\u7528\u5FA9\u539F\u9084\u539F\u3002": "Remove only the map file. Keep all topic notes. Undo is available.",
  "\u6AA2\u8996": "Review",
  "\u66F4\u591A\u5FC3\u667A\u5716\u64CD\u4F5C": "More mind map actions",
  "\u4F4E\u983B\u7684\u7BA1\u7406\u64CD\u4F5C\u96C6\u4E2D\u5728\u9019\u88E1\u3002": "Additional map management actions.",
  "\u91CD\u65B0\u547D\u540D\u5FC3\u667A\u5716": "Rename mind map",
  "\u8ACB\u5148\u6574\u7406\u820A\u8CC7\u6599\uFF0C\u518D\u91CD\u65B0\u547D\u540D\u4E3B\u984C\u3002": "Migrate old data before renaming this topic.",
  "\u522A\u9664\u5FC3\u667A\u5716": "Delete mind map",
  "\u53EA\u5C07\u5FC3\u667A\u5716\u6A94\u6848\u79FB\u5230 Vault \u5783\u573E\u6876\uFF0C\u4FDD\u7559\u6240\u6709\u8B70\u984C\u7B46\u8A18\u3002\u53EF\u4EE5\u4F7F\u7528\u5FA9\u539F\u9084\u539F\u3002": "Move only the map file to the vault trash. Keep all notes. You can undo this.",
  "\u8B70\u984C\u7B46\u8A18\u4E0D\u6703\u88AB\u522A\u9664\u3002": "Topic notes will be kept.",
  "\u79FB\u5230\u5783\u573E\u6876": "Move to trash",
  "\u6574\u7406\u7B46\u8A18": "Organize notes",
  "\u96C6\u4E2D\u8655\u7406\u66AB\u6642\u4E0D\u5728\u5FC3\u667A\u5716\u4E0A\u7684\u5167\u5BB9\u3002": "Manage notes that are currently outside the mind map.",
  "\u8A8D\u9818\u5230\u76EE\u524D\u5FC3\u667A\u5716\u3001\u5C01\u5B58\uFF0C\u6216\u79FB\u81F3\u5176\u4ED6\u4E3B\u984C\u3002": "Add to the current map, archive, or move to another topic.",
  "\u67E5\u770B\u5DF2\u5C01\u5B58\u7B46\u8A18\uFF0C\u6216\u5C07\u5B83\u5011\u79FB\u56DE\u672A\u6B78\u985E\u3002": "View archived notes or move them back to Unassigned.",
  "\u5C07\u9084\u6C92\u6709\u4E3B\u984C\u7684\u7B46\u8A18\u79FB\u5165\u9069\u5408\u7684\u4F4D\u7F6E\u3002": "Move notes without a topic to a suitable location.",
  "\u672A\u6B78\u985E\u7B46\u8A18": "Unassigned notes",
  "\u8A8D\u9818\u5230\u5FC3\u667A\u5716": "Add to mind map",
  "\u5C01\u5B58": "Archive",
  "\u79FB\u81F3\u5176\u4ED6\u4E3B\u984C": "Move to another topic",
  "\u79FB\u52D5\u4E26\u52A0\u5165\u5176\u4ED6\u4E3B\u984C": "Move and add to another topic",
  "\u79FB\u52D5\u4E26\u52A0\u5165\u5176\u4ED6\u5FC3\u667A\u5716": "Move and add to another mind map",
  "\u5C01\u5B58\u7B46\u8A18": "Archived notes",
  "\u53D6\u6D88\u5C01\u5B58": "Unarchive",
  "\u672A\u6307\u5B9A\u4E3B\u984C\u7684\u7B46\u8A18": "Notes without a topic",
  "\u79FB\u81F3\u76EE\u524D\u4E3B\u984C": "Move to current topic",
  "\u79FB\u52D5\u4E26\u52A0\u5165\u76EE\u524D\u5FC3\u667A\u5716": "Move and add to current mind map",
  "\u9078\u64C7\u5176\u4ED6\u4E3B\u984C": "Choose another topic",
  "\u79FB\u81F3\u4E3B\u984C": "Move to topic",
  "\u5207\u63DB\u5FC3\u667A\u5716": "Switch mind map",
  "\u9078\u64C7\u8981\u958B\u555F\u7684\u7814\u7A76\u4E3B\u984C": "Choose a research topic to open",
  "\uFF0B \u5FC3\u667A\u5716": "\uFF0B Mind map",
  "\u65B0\u589E\u5FC3\u667A\u5716": "New mind map",
  "\u65B0\u7684\u5FC3\u667A\u5716": "New mind map",
  "\u5FA9\u539F": "Undo",
  "\u91CD\u505A": "Redo",
  "\u66F4\u591A\u2026": "More\u2026",
  "\u65B0\u589E\u6216\u958B\u555F\u4E00\u5F35\u5FC3\u667A\u5716\uFF0C\u958B\u59CB\u6574\u7406\u4F60\u7684\u8B70\u984C\u3002": "Create or open a mind map to start organizing your topics.",
  "\uFF0B \u8B70\u984C": "\uFF0B Topic",
  "\u6574\u7406": "Organize",
  "\u7D50\u675F\u6574\u5408": "Finish selection",
  "\u7E2E\u5C0F": "Zoom out",
  "\u653E\u5927": "Zoom in",
  "\u986F\u793A\u5168\u90E8": "Show all",
  "\u9810\u89BD": "Preview",
  "\u62D6\u66F3\u7A7A\u767D\u8655\u5E73\u79FB \xB7 \u6EFE\u8F2A\u7E2E\u653E \xB7 \u9EDE\u9078\u7BC0\u9EDE\u7DE8\u8F2F": "Drag empty space to pan \xB7 Scroll to zoom \xB7 Click a node to edit",
  "\u8ACB\u9EDE\u9078\u81F3\u5C11 2 \u500B\u8B70\u984C": "Select at least 2 topics",
  "\u6E05\u9664": "Clear",
  "\u4E0B\u4E00\u6B65": "Next",
  "\u9019\u5F35\u5FC3\u667A\u5716\u9084\u6C92\u6709\u8B70\u984C\u3002\u9EDE\u300C\uFF0B \u8B70\u984C\u300D\u5EFA\u7ACB\u7B2C\u4E00\u500B\u7BC0\u9EDE\u3002": "This mind map has no topics. Click \u201C\uFF0B Topic\u201D to create the first node.",
  "\u7B46\u8A18\u4E0D\u5B58\u5728": "Note missing",
  "\u5F85\u78BA\u8A8D\u5EFA\u8B70": "Proposals to review",
  "\u5728\u53F3\u5074\u6B04\u958B\u555F\u8A73\u60C5": "Open details in right sidebar",
  "\u6536\u5408": "Collapse",
  "\u6A94\u6848\u5DF2\u79FB\u52D5\u6216\u522A\u9664\uFF0C\u53EF\u5F9E\u5716\u4E2D\u79FB\u9664\u6B64\u7BC0\u9EDE\u3002": "The file was moved or deleted. You can remove this node from the map.",
  "\u8B70\u984C\u64CD\u4F5C": "Topic actions",
  "\u9078\u64C7\u64CD\u4F5C": "Choose an action",
  "\u65B0\u589E\u5B50\u8B70\u984C": "Add subtopic",
  "AI \u62C6\u89E3\u8B70\u984C": "Ask AI to break down topic",
  "\u5C55\u958B\u5206\u652F": "Expand branch",
  "\u6536\u5408\u5206\u652F": "Collapse branch",
  "\u91CD\u65B0\u8B80\u53D6\u7B46\u8A18": "Reload note",
  "\u5F9E\u5716\u4E2D\u79FB\u9664": "Remove from map",
  "\u5C1A\u672A\u52A0\u5165\u9810\u89BD\u5167\u5BB9": "No preview content yet",
  "\u8B70\u984C\u5DE5\u4F5C\u53F0": "Topic workspace",
  "\u672A\u547D\u540D\u8B70\u984C": "Untitled topic",
  "\u8B70\u984C": "Topic",
  "\u76EE\u524D\u7406\u89E3": "Current understanding",
  "AI \u5B8C\u6210\u5F8C\u6703\u76F4\u63A5\u66F4\u65B0\u76EE\u524D\u7406\u89E3\uFF0C\u5B8C\u6574\u7D50\u679C\u6703\u4FDD\u5B58\u5728 MD \u8A73\u60C5\u4E2D\u3002\u9001\u51FA\u524D\u53EF\u8ABF\u6574\u4EFB\u52D9\u3002": "AI will update the current understanding and save full results in the Markdown details. Edit the task before submitting.",
  "\u7814\u7A76\u9019\u500B\u8B70\u984C": "Research this topic",
  "\u88DC\u8DB3\u8CC7\u8A0A\u3001\u4F86\u6E90\u8207\u4ECD\u5F85\u78BA\u8A8D\u4E4B\u8655\u3002": "Fill gaps in information, sources and open questions.",
  "\u78BA\u8A8D\u7814\u7A76\u4EFB\u52D9": "Confirm research task",
  "\u6BD4\u8F03\u53EF\u884C\u9078\u9805": "Compare options",
  "\u6574\u7406\u65B9\u6848\u3001\u53D6\u6368\u8207\u5EFA\u8B70\u3002": "Compare options, tradeoffs and recommendations.",
  "\u78BA\u8A8D\u6BD4\u8F03\u4EFB\u52D9": "Confirm comparison task",
  "\u6AA2\u67E5\u98A8\u96AA\u8207\u5047\u8A2D": "Check risks and assumptions",
  "\u5C0B\u627E\u53CD\u4F8B\u3001\u98A8\u96AA\u53CA\u5F85\u9A57\u8B49\u5047\u8A2D\u3002": "Find counterexamples, risks and assumptions to validate.",
  "\u78BA\u8A8D\u98A8\u96AA\u6AA2\u67E5\u4EFB\u52D9": "Confirm risk review",
  "\u7531 AI \u62C6\u6210\u5B50\u8B70\u984C": "Ask AI to propose subtopics",
  "\u7522\u751F 3\u20137 \u500B\u5EFA\u8B70\uFF1B\u78BA\u8A8D\u5F8C\u624D\u5EFA\u7ACB\u7BC0\u9EDE\u3002": "Propose 3\u20137 subtopics. Create nodes only after confirmation.",
  "\u6574\u5408\u5B50\u8B70\u984C\u767C\u73FE": "Synthesize subtopic findings",
  "\u5F59\u6574\u76F4\u5C6C\u5B50\u8B70\u984C\uFF1B\u78BA\u8A8D\u4EFB\u52D9\u5F8C\u81EA\u52D5\u66F4\u65B0\u76EE\u524D\u7406\u89E3\u3002": "Combine direct subtopics and update understanding after task confirmation.",
  "\u624B\u52D5\u65B0\u589E\u5B50\u8B70\u984C": "Add subtopic manually",
  "\u5EFA\u7ACB\u7A7A\u767D\u5B50\u8B70\u984C\uFF0C\u4E0D\u6703\u57F7\u884C AI\u3002": "Create an empty subtopic without running AI.",
  "\u81EA\u5DF1\u63CF\u8FF0\u4E0B\u4E00\u6B65": "Describe the next step",
  "\u81EA\u884C\u64B0\u5BEB\u9019\u6B21\u8981 AI \u5B8C\u6210\u7684\u5DE5\u4F5C\uFF0C\u53EF\u53EA\u5132\u5B58\u6216\u78BA\u8A8D\u4E26\u57F7\u884C\u3002": "Write your own task. Save it or confirm and run.",
  "\u57F7\u884C\u5DF2\u4FDD\u5B58\u7684\u4EFB\u52D9": "Run saved task",
  "\u57F7\u884C\u5148\u524D\u4FDD\u5B58\u7684\u4EFB\u52D9\uFF1B\u9001\u51FA\u524D\u4ECD\u53EF\u4FEE\u6539\u3002": "Run the saved task. You can edit it before submitting.",
  "\u78BA\u8A8D\u5DF2\u4FDD\u5B58\u7684\u4EFB\u52D9": "Confirm saved task",
  "AI \u57F7\u884C\u4E2D\u2026": "AI running\u2026",
  "\u9078\u64C7\u4E0B\u4E00\u6B65": "Choose next step",
  "\u9078\u64C7\u76EE\u7684\u5F8C\uFF0C\u518D\u78BA\u8A8D AI \u5C07\u57F7\u884C\u7684\u4EFB\u52D9\u3002": "Choose a goal, then confirm the AI task.",
  "\u6A21\u578B\u8207\u9032\u968E\u8A2D\u5B9A": "Model and advanced settings",
  "\u4F7F\u7528\u6A21\u578B": "Model",
  "\u81EA\u8A02\u6A21\u578B\u2026": "Custom model\u2026",
  "\u8F38\u5165\u6A21\u578B ID": "Enter model ID",
  "\u81EA\u8A02\u6A21\u578B ID": "Custom model ID",
  "\u5DE5\u4F5C\u5340\u9810\u8A2D": "Workspace default",
  "\u5EFA\u7ACB\u6642\u7E7C\u627F": "Inherited at creation",
  "\u624B\u52D5\u6307\u5B9A": "Manually selected",
  "\u6B64\u7BC0\u9EDE\u7684\u7B46\u8A18\u4E0D\u5B58\u5728\uFF0C\u53EF\u91CD\u65B0\u9023\u7D50\u672A\u6B78\u985E\u7B46\u8A18\u6216\u5F9E\u5716\u4E2D\u79FB\u9664\u3002": "This node's note is missing. Relink an unassigned note or remove it from the map.",
  "\u91CD\u65B0\u9023\u7D50\u7B46\u8A18": "Relink note",
  "\u4F7F\u7528\u9019\u4EFD\u7B46\u8A18": "Use this note",
  "\u7D50\u69CB\u8207\u9023\u7D50": "Structure and links",
  "\u6240\u5C6C\u6BCD\u8B70\u984C": "Parent topic",
  "\u6BCD\u8B70\u984C\uFF0F\u9023\u7D50": "Parent topic / link",
  "\u7121\u6BCD\u8B70\u984C\uFF08\u6839\u8B70\u984C\uFF09": "No parent (root topic)",
  "\u4E0D\u80FD\u5EFA\u7ACB\u5FAA\u74B0\u9023\u7D50\u3002": "Circular links are not allowed.",
  "\u79FB\u9664\u6BCD\u8B70\u984C\u9023\u7D50": "Remove parent link",
  "\u66F4\u63DB\u6BCD\u8B70\u984C\u6703\u5F71\u97FF\u4E0B\u6B21 AI \u4EFB\u52D9\u53D6\u5F97\u7684\u80CC\u666F\uFF0C\u4E0D\u6703\u66F4\u52D5\u6A21\u578B\u3002": "Changing the parent affects context for the next AI task. The model stays the same.",
  "\u7B46\u8A18\u6703\u79FB\u81F3\u76EE\u524D\u4E3B\u984C\u7684 Unassigned\uFF0C\u53EF\u91CD\u65B0\u8A8D\u9818\u6216\u5FA9\u539F\u3002": "The note will move to this topic's Unassigned folder. You can add it back or undo.",
  "\u53EA\u79FB\u9664\u6B64\u7BC0\u9EDE\uFF0C\u5B50\u8B70\u984C\u8B8A\u6210\u6839\u8B70\u984C": "Remove only this node; children become roots",
  "\u79FB\u9664\u6574\u500B\u5206\u652F": "Remove entire branch",
  "\u6C92\u6709\u9700\u8981\u6574\u7406\u7684\u820A\u8CC7\u6599\u3002": "No old data to migrate.",
  "\u6574\u7406\u820A\u7248\u8CC7\u6599": "Migrate legacy data",
  "\u78BA\u8A8D\u6574\u7406": "Confirm migration",
  "\u820A\u8CC7\u6599\u5DF2\u6574\u7406\u70BA\u4E3B\u984C\u8CC7\u6599\u593E\u3002": "Old data was migrated into topic folders.",
  "\u6C92\u6709\u7F3A\u5C11 Map.md \u7684\u4E3B\u984C\u3002": "No topics with a missing Map.md.",
  "\u4FEE\u5FA9\u907A\u5931 Map": "Repair missing map",
  "\u9078\u64C7\u8981\u4FEE\u5FA9\u7684\u4E3B\u984C": "Choose a topic to repair",
  "\u53EF\u7531 Notes \u91CD\u5EFA\u6240\u6709\u7BC0\u9EDE\u7686\u70BA\u6839\u7BC0\u9EDE\u7684\u65B0 Map\uFF0C\u6216\u91CD\u65B0\u9023\u7D50\u4F4D\u65BC\u4E3B\u984C\u8CC7\u6599\u593E\u5916\u7684\u65E2\u6709 Map\u3002": "Rebuild a map from Notes as root nodes, or relink an existing map outside the topic folder.",
  "\u5F9E Notes \u91CD\u5EFA": "Rebuild from Notes",
  "\u91CD\u65B0\u9023\u7D50\u65E2\u6709 Map": "Relink existing map",
  "\u9078\u64C7\u65E2\u6709 Map": "Choose existing map",
  "\u9078\u53D6\u5F8C\u6703\u642C\u56DE\u6B64\u4E3B\u984C\u4E26\u91CD\u65B0\u5EFA\u7ACB\u53EF\u8FA8\u8B58\u7684\u7BC0\u9EDE\u8DEF\u5F91\u3002": "Move the selected map into this topic and rebuild node paths.",
  "\u8ACB\u5148\u4F7F\u7528\u300C\u6574\u7406\u820A\u8CC7\u6599\u300D\u8F49\u63DB\u76EE\u524D\u5FC3\u667A\u5716\u3002": "Use \u201CMigrate old data\u201D to convert this map first.",
  "\u65B0\u7684\u5B50\u8B70\u984C": "New subtopic",
  "\u6211\u7684\u6838\u5FC3\u8B70\u984C": "My core topic",
  "\u78BA\u8A8D AI \u62C6\u89E3": "Confirm AI breakdown",
  "\u9019\u6703\u57F7\u884C\u4E00\u6B21\u4F4E\u63A8\u7406 AI \u4EFB\u52D9\uFF0C\u4E0D\u6703\u76F4\u63A5\u4FEE\u6539\u5FC3\u667A\u5716\u7D50\u69CB\u3002": "Run one AI task with low reasoning. The map structure will stay unchanged until confirmation.",
  "AI \u8A8D\u70BA\u76EE\u524D\u4E0D\u9700\u8981\u62C6\u89E3\uFF0C\u6216\u6C92\u6709\u63D0\u51FA\u53EF\u5EFA\u7ACB\u7684\u5B50\u8B70\u984C\u3002": "AI did not suggest any subtopics to create.",
  "\u9019\u500B\u8B70\u984C\u76EE\u524D\u6C92\u6709\u76F4\u5C6C\u5B50\u8B70\u984C\u3002": "This topic has no direct subtopics.",
  "\u78BA\u8A8D\u6574\u5408\u5B50\u8B70\u984C": "Confirm subtopic synthesis",
  "\u9019\u6703\u57F7\u884C\u4E00\u6B21\u9AD8\u63A8\u7406 AI \u4EFB\u52D9\u3002": "Run one AI task with high reasoning.",
  "\u5B50\u8B70\u984C\u6574\u5408\u5DF2\u5BEB\u5165\u76EE\u524D\u7406\u89E3\u8207 MD \u8A73\u60C5\u3002": "Subtopic synthesis was saved to current understanding and Markdown details.",
  "\u8ACB\u81F3\u5C11\u9078\u53D6\u5169\u500B\u8B70\u984C\u3002": "Select at least two topics.",
  "\u8ACB\u5148\u8F38\u5165\u8981\u4EA4\u7D66 AI \u7684\u554F\u984C\u6216\u4EFB\u52D9\u3002": "Enter a question or task for AI first.",
  "AI \u4EFB\u52D9\u5931\u6557\u3002": "AI task failed.",
  "\u4F7F\u7528\u672C\u6A5F Codex ACP / Claude Code \u767B\u5165\u72C0\u614B\u3002AI \u4EFB\u52D9\u5B8C\u6210\u5F8C\u6703\u76F4\u63A5\u66F4\u65B0\u76EE\u524D\u7406\u89E3\uFF0C\u5B8C\u6574\u7D50\u679C\u4FDD\u5B58\u5728\u8B70\u984C MD \u8A73\u60C5\u4E2D\u3002": "Uses your local Codex ACP / Claude Code login. AI updates current understanding and saves full results in the topic's Markdown details.",
  "Codex ACP \u8DEF\u5F91": "Codex ACP path",
  "\u7528\u65BC\u5E38\u99D0 Codex session \u8207\u81EA\u52D5\u53D6\u5F97\u6A21\u578B\u6E05\u55AE\u3002": "Used for persistent Codex sessions and automatic model discovery.",
  "Claude Code CLI \u8DEF\u5F91": "Claude Code CLI path",
  "\u7528\u65BC claude:sonnet\u3001claude:opus\u3001claude:fable\uFF1B\u9700\u5148\u5B8C\u6210 Claude Code \u767B\u5165\u3002": "Used for claude:sonnet, claude:opus and claude:fable. Sign in to Claude Code first.",
  "\u5DE5\u4F5C\u5340\u9810\u8A2D Model": "Workspace default model",
  "\u76EE\u524D\u6700\u4F4E\u6210\u672C\u6A21\u578B\u70BA gpt-5.6-luna\uFF1B\u8B8A\u66F4\u53EA\u5F71\u97FF\u4E4B\u5F8C\u65B0\u589E\u7684\u6839\u8B70\u984C\u3002": "Default: gpt-5.6-luna. Changes apply to newly created root topics.",
  "Model \u9078\u55AE": "Model list",
  "\u555F\u52D5\u5F8C\u6703\u512A\u5148\u88DC\u5165 Codex ACP \u56DE\u5831\u7684\u6A21\u578B\uFF1BClaude Code \u8ACB\u4F7F\u7528 claude:sonnet\u3001claude:opus \u6216 claude:fable\u3002": "Models reported by Codex ACP are added on startup. For Claude Code, use claude:sonnet, claude:opus or claude:fable.",
  "\u4E00\u822C\u4EFB\u52D9\u4F7F\u7528\u4F4E\u63A8\u7406\uFF1B\u6574\u5408\u5B50\u8B70\u984C\u4F7F\u7528\u9AD8\u63A8\u7406\u3002": "Regular tasks use low reasoning; subtopic synthesis uses high reasoning.",
  "Codex CLI fallback \u8DEF\u5F91": "Codex CLI fallback path",
  "\u53EA\u6709 Codex ACP \u5931\u6557\u6642\u624D\u4F7F\u7528\u3002": "Used only when Codex ACP fails.",
  "\u91CD\u5EFA\u8B70\u984C reference": "Rebuild topic references",
  "\u8B70\u984C reference \u5DF2\u4F9D\u5FC3\u667A\u5716\u91CD\u5EFA\u3002": "Topic references were rebuilt from the mind map.",
  "\u540C\u6B65\u8B70\u984C\u540D\u7A31\u8207\u6A94\u540D": "Sync topic names and filenames",
  "\u8B70\u984C\u6A94\u540D\u5DF2\u662F\u6700\u65B0\u72C0\u614B\u3002": "Topic filenames are up to date.",
  "\u4EE5\u5FC3\u667A\u5716\u958B\u555F": "Open as mind map",
  "\u7121\u6CD5\u958B\u555F\u53F3\u5074\u8A73\u60C5\u6B04\u3002": "Unable to open the right details sidebar.",
  "CLI \u6A21\u5F0F\u53EA\u652F\u63F4\u684C\u9762\u7248 Obsidian": "CLI mode requires desktop Obsidian",
  "\u627E\u4E0D\u5230\u5916\u639B\u76EE\u9304": "Plugin folder not found",
  "Codex ACP \u5C1A\u672A\u555F\u52D5": "Codex ACP has not started",
  "Codex ACP \u56DE\u50B3\u932F\u8AA4": "Codex ACP returned an error",
  "Codex ACP \u6C92\u6709\u5EFA\u7ACB session": "Codex ACP did not create a session",
  "Codex CLI \u57F7\u884C\u8D85\u904E 15 \u5206\u9418": "Codex CLI exceeded 15 minutes",
  "Claude Code CLI \u57F7\u884C\u8D85\u904E 15 \u5206\u9418": "Claude Code CLI exceeded 15 minutes",
  "Claude Code CLI \u56DE\u50B3\u932F\u8AA4": "Claude Code CLI returned an error",
  "\u5C07\u6574\u5408 {0} \u500B\u4F86\u6E90\u8B70\u984C\uFF0CAI \u6703\u8B80\u53D6\u5B8C\u6574\u77E5\u8B58\u5167\u5BB9\u4E26\u5EFA\u7ACB\u65B0\u7684\u6839\u8B70\u984C\u3002": "Synthesize {0} source topics. AI reads their full knowledge and creates a new root topic.",
  "{0}\u6709\u5916\u90E8\u4FEE\u6539": "{0} changed externally",
  "\u5408\u4F75\u5167\u5BB9\u7121\u6548\uFF1A{0}": "Invalid merged contents: {0}",
  "\u522A\u9664\u300C{0}\u300D": "Delete \u201C{0}\u201D",
  "\u672A\u6B78\u985E\uFF08{0}\uFF09": "Unassigned ({0})",
  "\u5C01\u5B58\uFF08{0}\uFF09": "Archived ({0})",
  "\u6536\u4EF6\u5323\uFF08{0}\uFF09": "Inbox ({0})",
  "\u5DF2\u9078 {0} \u500B\uFF1A{1}{2}": "Selected {0}: {1}{2}",
  "\u5C55\u958B {0}": "Expand {0}",
  "{0}\uFF08\u5DF2\u79FB\u52D5\uFF09": "{0} (moved)",
  "\u67E5\u770B AI \u5B50\u8B70\u984C\u5EFA\u8B70\uFF08{0}\uFF09": "Review AI subtopic proposals ({0})",
  "{0} \xB7 {1}\uFF1B\u4E00\u822C\u4EFB\u52D9\u4F7F\u7528\u4F4E\u63A8\u7406\uFF0C\u6574\u5408\u5B50\u8B70\u984C\u4F7F\u7528\u9AD8\u63A8\u7406\u3002": "{0} \xB7 {1}; regular tasks use low reasoning, synthesis uses high reasoning.",
  "\u4F7F\u7528 {0}": "Use {0}",
  "\u5B50\u8B70\u984C\u5EFA\u8B70\u5B8C\u6210\uFF1A{0} \u9805\u3002\u9EDE\u9078\u7BC0\u9EDE\u5F8C\u53EF\u67E5\u770B\u3002": "{0} subtopic proposals ready. Click the node to review.",
  "AI \u4EFB\u52D9\u5931\u6557\uFF1A{0}": "AI task failed: {0}",
  "\u4E3B\u984C\u8CC7\u6599\u593E\uFF1A{0}\u3000\u672A\u5206\u985E\u6536\u4EF6\u5323\uFF1A{1}": "Topics folder: {0} \xB7 Inbox: {1}",
  "\u5DF2\u5C07 {0} \u4EFD\u5B50\u8B70\u984C\u6A94\u540D\u540C\u6B65\u70BA\u8B70\u984C\u540D\u7A31\u3002": "Synced {0} subtopic filenames with their names.",
  "\u5DF2\u540C\u6B65 {0} \u4EFD\u8B70\u984C\u6A94\u540D\u3002": "Synced {0} topic filenames.",
  "\u7121\u6CD5\u5957\u7528\u8B70\u984C\u7B46\u8A18\u986F\u793A\u8A2D\u5B9A\uFF1A{0}": "Unable to apply note display settings: {0}",
  "\u5FC3\u667A\u5716\u5DF2\u5132\u5B58\uFF0C\u4F46 reference \u66F4\u65B0\u5931\u6557\uFF1A{0}": "Map saved, but reference update failed: {0}",
  "\u5C07\u5EFA\u7ACB {0} \u500B\u4E3B\u984C\u8CC7\u6599\u593E\uFF0C\u642C\u79FB {1} \u4EFD\u5716\u5167\u7B46\u8A18\uFF0C\u4E26\u5C07 {2} \u4EFD\u5B64\u5152\u7B46\u8A18\u79FB\u81F3 Inbox\u3002\u4EFB\u4E00\u6B65\u5931\u6557\u90FD\u6703\u9084\u539F\u5DF2\u642C\u79FB\u7684\u6A94\u6848\u3002": "Create {0} topic folders, move {1} map notes and move {2} orphan notes to Inbox. If any step fails, moved files will be restored.",
  "{0}\uFF08{1} \u4EFD Notes\uFF09": "{0} ({1} notes)",
  "AI \u6703\u5206\u6790\u76EE\u524D\u8B70\u984C\u4E26\u63D0\u51FA 3\u20137 \u500B\u5B50\u8B70\u984C\uFF1B\u7D50\u679C\u5B8C\u6210\u5F8C\u4ECD\u9700\u7531\u4F60\u78BA\u8A8D\u624D\u6703\u5EFA\u7ACB\u7BC0\u9EDE\u3002\n\n\u672C\u6B21\u5957\u7528\u7684 AI \u898F\u5247\uFF1A\n{0}": "AI proposes 3\u20137 subtopics. Nodes are created only after your confirmation.\n\nAI rules for this task:\n{0}",
  "AI \u6703\u8B80\u53D6 {0} \u500B\u76F4\u5C6C\u5B50\u8B70\u984C\uFF1B\u5B8C\u6210\u5F8C\u76F4\u63A5\u66F4\u65B0\u76EE\u524D\u7406\u89E3\u8207 MD \u8A73\u60C5\u3002\n\n\u672C\u6B21\u5957\u7528\u7684 AI \u898F\u5247\uFF1A\n{1}": "AI reads {0} direct subtopics and updates current understanding and Markdown details.\n\nAI rules for this task:\n{1}"
};
var language = "zh-TW";
function setUiLanguage(value) {
  language = value;
}
function t(text, ...values) {
  var _a;
  const translated = language === "en" ? (_a = english[text]) != null ? _a : text : text;
  return translated.replace(/\{(\d+)\}/g, (_, index) => {
    var _a2;
    return String((_a2 = values[Number(index)]) != null ? _a2 : "");
  });
}

// main.ts
var import_obsidian4 = require("obsidian");

// ui/modals/name-modal.ts
var import_obsidian = require("obsidian");
var NameModal = class extends import_obsidian.Modal {
  constructor(app, titleText, value, submit) {
    super(app);
    this.titleText = titleText;
    this.value = value;
    this.submit = submit;
  }
  onOpen() {
    this.titleEl.setText(this.titleText);
    const input = this.contentEl.createEl("input", { type: "text", value: this.value });
    input.setAttr("aria-label", this.titleText);
    input.style.width = "100%";
    const save = () => {
      const value = input.value.trim();
      if (value) {
        this.close();
        this.submit(value);
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") save();
    });
    new import_obsidian.Setting(this.contentEl).addButton((b) => b.setButtonText(t("\u53D6\u6D88")).onClick(() => this.close())).addButton((b) => b.setButtonText(t("\u5132\u5B58")).setCta().onClick(save));
    input.focus();
    input.select();
  }
};

// ui/modals/choice-modal.ts
var import_obsidian2 = require("obsidian");
var ChoiceModal = class extends import_obsidian2.Modal {
  constructor(app, titleText, description, choices) {
    super(app);
    this.titleText = titleText;
    this.description = description;
    this.choices = choices;
  }
  onOpen() {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.description, cls: "vam-modal-intro" });
    for (const choice of this.choices) {
      const setting = new import_obsidian2.Setting(this.contentEl);
      if (choice.description) setting.setName(choice.label).setDesc(choice.description).addButton((b) => {
        var _a;
        return b.setButtonText((_a = choice.buttonLabel) != null ? _a : t("\u9078\u64C7")).onClick(() => {
          this.close();
          choice.action();
        });
      });
      else setting.addButton((b) => b.setButtonText(choice.label).onClick(() => {
        this.close();
        choice.action();
      }));
    }
    new import_obsidian2.Setting(this.contentEl).addButton((b) => b.setButtonText(t("\u53D6\u6D88")).onClick(() => this.close()));
  }
};

// main.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// map-model.ts
var clone = (value) => JSON.parse(JSON.stringify(value));
function descendants(nodes, id) {
  const found = /* @__PURE__ */ new Set();
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop();
    for (const node of nodes) {
      if (node.parentId === parent && node.id !== id && !found.has(node.id)) {
        found.add(node.id);
        pending.push(node.id);
      }
    }
  }
  return found;
}
function canParent(nodes, id, parentId) {
  return parentId === null || parentId !== id && nodes.some((n) => n.id === parentId) && !descendants(nodes, id).has(parentId);
}
function visibleNodes(nodes) {
  const hidden = /* @__PURE__ */ new Set();
  for (const node of nodes) if (node.collapsed) for (const id of descendants(nodes, node.id)) hidden.add(id);
  return nodes.filter((node) => !hidden.has(node.id));
}
function removeNodes(nodes, id, branch) {
  const removed = branch ? descendants(nodes, id) : /* @__PURE__ */ new Set();
  removed.add(id);
  return nodes.filter((node) => !removed.has(node.id)).map((node) => ({ ...node, parentId: node.parentId && removed.has(node.parentId) ? null : node.parentId }));
}
function parseMap(content) {
  const block = content.match(/```agent-map\s*\n([\s\S]*?)\n```/);
  if (!block) throw new Error("\u627E\u4E0D\u5230\u5FC3\u667A\u5716\u8CC7\u6599\u5340\u584A\uFF0C\u8ACB\u4FDD\u7559 agent-map \u5340\u584A\u3002");
  const map = JSON.parse(block[1]);
  if (map.version !== 1 || typeof map.id !== "string" || typeof map.title !== "string" || !Array.isArray(map.nodes)) throw new Error("\u5FC3\u667A\u5716\u683C\u5F0F\u4E0D\u6B63\u78BA\u3002");
  const ids = /* @__PURE__ */ new Set();
  for (const n of map.nodes) {
    if (!n || typeof n.id !== "string" || typeof n.path !== "string" || !n.path.endsWith(".md") || !Number.isFinite(n.x) || !Number.isFinite(n.y) || n.parentId !== null && typeof n.parentId !== "string" || ids.has(n.id)) throw new Error("\u7BC0\u9EDE\u8CC7\u6599\u4E0D\u6B63\u78BA\u6216 ID \u91CD\u8907\u3002");
    ids.add(n.id);
    n.collapsed = n.collapsed === true;
  }
  for (const n of map.nodes) if (!canParent(map.nodes, n.id, n.parentId)) throw new Error("\u9023\u7D50\u6709\u5FAA\u74B0\u6216\u6307\u5411\u4E0D\u5B58\u5728\u7684\u6BCD\u8B70\u984C\u3002");
  if (!map.viewport || !Number.isFinite(map.viewport.x) || !Number.isFinite(map.viewport.y) || !Number.isFinite(map.viewport.zoom)) map.viewport = { x: 40, y: 40, zoom: 1 };
  map.viewport.zoom = Math.min(2, Math.max(0.25, map.viewport.zoom));
  return map;
}
function serializeMap(map) {
  return `---
visual-agent-map: true
---

# ${map.title.replace(/\n/g, " ")}

\u6B64\u6A94\u6848\u4FDD\u5B58\u5FC3\u667A\u5716\u7D50\u69CB\uFF1B\u5B8C\u6574\u5167\u5BB9\u4FDD\u5B58\u5728\u5404\u8B70\u984C\u7B46\u8A18\u3002\u5F9E\u6A94\u6848\u9078\u55AE\u9078\u64C7\u300C\u4EE5\u5FC3\u667A\u5716\u958B\u555F\u300D\u3002

\`\`\`agent-map
${JSON.stringify(map, null, 2)}
\`\`\`
`;
}
function inheritModel(parentModel, defaultModel) {
  return parentModel != null ? parentModel : defaultModel;
}
var History = class {
  constructor() {
    __publicField(this, "past", []);
    __publicField(this, "future", []);
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  push(entry) {
    this.past.push(entry);
    if (this.past.length > 80) this.past.shift();
    this.future = [];
  }
  undo() {
    const entry = this.past.pop();
    if (entry) this.future.push(entry);
    return entry;
  }
  redo() {
    const entry = this.future.pop();
    if (entry) this.past.push(entry);
    return entry;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
};

// repository.ts
var import_obsidian3 = require("obsidian");
var DEFAULT_SETTINGS = {
  language: "zh-TW",
  workspaceFolder: "Agent Workspace",
  topicsFolder: "Agent Workspace/Topics",
  inboxFolder: "Agent Workspace/Inbox",
  notesFolder: "Agent Workspace/Nodes",
  mapsFolder: "Agent Workspace/Maps",
  mapId: "default",
  cliPath: "codex",
  codexAcpPath: "/opt/homebrew/bin/codex-acp",
  claudePath: "/Users/kevintsai/.local/bin/claude",
  cliModel: "gpt-5.6-luna",
  cliReasoning: "low",
  previewScale: 120,
  models: "gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, claude:sonnet, claude:opus, claude:fable",
  migrated: false,
  structureVersion: 2,
  firstUseNoticeSeen: false
};
var REFERENCE_START = "<!-- visual-agent-map:references:start -->";
var REFERENCE_END = "<!-- visual-agent-map:references:end -->";
var DETAIL_START = "<!-- visual-agent-map:detail:start -->";
var DETAIL_END = "<!-- visual-agent-map:detail:end -->";
var NOTE_CSS_CLASS = "visual-agent-map-node";
function marker(value) {
  return value === true || value === "true";
}
function parentPath(path) {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}
function baseName(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
function ensureNoteCssClass(fm) {
  const current = Array.isArray(fm.cssclasses) ? fm.cssclasses.map(String) : typeof fm.cssclasses === "string" ? fm.cssclasses.split(/[\s,]+/).filter(Boolean) : [];
  if (current.includes(NOTE_CSS_CLASS)) return false;
  fm.cssclasses = [...current, NOTE_CSS_CLASS];
  return true;
}
function safeName(title) {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "\u672A\u547D\u540D\u4E3B\u984C";
}
function frontmatter(content) {
  var _a, _b;
  const yaml = (_a = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)) == null ? void 0 : _a[1];
  return yaml ? (_b = (0, import_obsidian3.parseYaml)(yaml)) != null ? _b : {} : {};
}
function sectionBounds(content, heading) {
  if (heading === "Detail") {
    const managedStart = content.indexOf(DETAIL_START), managedEnd = content.indexOf(DETAIL_END);
    if (managedStart >= 0 && managedEnd > managedStart) return { start: managedStart + DETAIL_START.length, end: managedEnd };
  }
  const match = new RegExp(`^## ${heading.replace(" ", "\\s+")}\\s*$`, "m").exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const next = /^## .+$/m.exec(content.slice(start));
  const reference = content.indexOf(REFERENCE_START, start);
  const candidates = [next ? start + next.index : content.length, reference >= 0 ? reference : content.length];
  return { start, end: Math.min(...candidates) };
}
function section(content, heading) {
  const bounds = sectionBounds(content, heading);
  return bounds ? content.slice(bounds.start, bounds.end).trim() : "";
}
function replaceSection(content, heading, value) {
  const bounds = sectionBounds(content, heading);
  if (bounds) {
    if (heading === "Detail" && !content.slice(0, bounds.start).includes(DETAIL_START)) {
      return `${content.slice(0, bounds.start)}

${DETAIL_START}
${value.trim()}
${DETAIL_END}

${content.slice(bounds.end).replace(/^\s*/, "")}`;
    }
    return `${content.slice(0, bounds.start)}
${value.trim()}
${content.slice(bounds.end)}`;
  }
  const reference = content.indexOf(REFERENCE_START);
  const at = reference >= 0 ? reference : content.length;
  const managed = heading === "Detail" ? `${DETAIL_START}
${value.trim()}
${DETAIL_END}` : value.trim();
  return `${content.slice(0, at).trimEnd()}

## ${heading}

${managed}

${content.slice(at).trimStart()}`;
}
function replaceSummarySection(content, value) {
  if (sectionBounds(content, "Current Summary")) return replaceSection(content, "Current Summary", value);
  const title = /^# .*$/m.exec(content);
  if (!title) return replaceSection(content, "Current Summary", value);
  const at = title.index + title[0].length;
  return `${content.slice(0, at)}

## Current Summary

${value.trim()}

${content.slice(at).trimStart()}`;
}
function removeSection(content, heading) {
  if (heading === "Detail") {
    const managedStart = content.indexOf(DETAIL_START), managedEnd = content.indexOf(DETAIL_END);
    if (managedStart >= 0 && managedEnd > managedStart) {
      const headingMatch2 = /^## Detail\s*$/m.exec(content.slice(0, managedStart));
      const start = headingMatch2 ? headingMatch2.index : managedStart;
      return `${content.slice(0, start).trimEnd()}

${content.slice(managedEnd + DETAIL_END.length).trimStart()}`;
    }
  }
  const bounds = sectionBounds(content, heading);
  if (!bounds) return content;
  const headingMatch = new RegExp(`^## ${heading.replace(" ", "\\s+")}\\s*$`, "m").exec(content.slice(0, bounds.start));
  if (!headingMatch) return content;
  return `${content.slice(0, headingMatch.index).trimEnd()}

${content.slice(bounds.end).trimStart()}`;
}
function ensurePreview(content) {
  const legacy = section(content, "User Notes");
  const preview = section(content, "\u9810\u89BD");
  const merged = [preview, legacy].filter(Boolean).join("\n\n");
  return replaceSection(removeSection(content, "User Notes"), "\u9810\u89BD", merged);
}
function withoutReference(content) {
  const managed = new RegExp(`\\n?${REFERENCE_START}[\\s\\S]*?${REFERENCE_END}\\n?`, "m");
  if (managed.test(content)) return content.replace(managed, "\n");
  const legacy = /\n?^## 關聯議題\s*\n+(?:母議題：[^\n]*\n+)?(?:子議題：[^\n]*\n*)?$/m;
  return legacy.test(content) ? content.replace(legacy, "\n") : content;
}
function detailWithVisualReferences(detail, visualReferences) {
  var _a;
  let current = detail.trim();
  const references = visualReferences.trim().split(/\n(?=\*\*[^\n]+\*\*\n|### )/).filter(Boolean);
  for (const reference of references) {
    const image = reference.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (!image || current.includes(`](${image[1]})`)) continue;
    const block = reference.replace(/^### (.+)$/gm, "**$1**").trim();
    const title = (_a = block.match(/^\*\*(.+)\*\*/)) == null ? void 0 : _a[1];
    const paragraphs = current.split("\n\n");
    const related = title ? paragraphs.findIndex((text) => !/^#{1,6} /.test(text) && text.includes(title)) : -1;
    if (related >= 0) {
      paragraphs.splice(related + 1, 0, block);
      current = paragraphs.join("\n\n");
    } else {
      const knowledge = /^### 關鍵知識\s*$/m.exec(current);
      const next = knowledge ? /^### .+$/m.exec(current.slice(knowledge.index + knowledge[0].length)) : null;
      const at = knowledge && next ? knowledge.index + knowledge[0].length + next.index : current.length;
      current = [current.slice(0, at).trimEnd(), block, current.slice(at).trimStart()].filter(Boolean).join("\n\n");
    }
  }
  return current;
}
function initialPreview(summary, detail) {
  var _a;
  const image = (_a = detail.match(/!\[[^\]]*\]\((?:https?:\/\/[^)\s]+)\)/)) == null ? void 0 : _a[0];
  return [summary.trim(), image].filter(Boolean).join("\n\n");
}
function noteBody(title, summary, prompt = "", rules = "", preview = "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6", detail = "", visualReferences = "", newFindings = "", leftover = "") {
  const detailBlock = `${DETAIL_START}
${detailWithVisualReferences(detail, visualReferences)}
${DETAIL_END}`;
  return [
    `# ${title}`,
    `## Current Summary

${summary.trim() || "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6"}`,
    `## Prompt

${prompt.trim()}`,
    `## Rules

${rules.trim()}`,
    `## \u9810\u89BD

${preview.trim()}`,
    `## Detail

${detailBlock}`,
    newFindings.trim() ? `## Working Findings

${newFindings.trim()}` : "",
    leftover.trim()
  ].filter(Boolean).join("\n\n") + "\n";
}
function normalizeBodyOrder(content, title, summaryFallback) {
  const clean = ensurePreview(withoutReference(content));
  const summary = section(clean, "Current Summary") || summaryFallback;
  const prompt = section(clean, "Prompt");
  const rules = section(clean, "Rules");
  const preview = section(clean, "\u9810\u89BD");
  const detail = detailWithVisualReferences(section(clean, "Detail"), section(clean, "Visual References"));
  const newFindings = section(clean, "Working Findings") || section(clean, "New Findings");
  let leftover = clean.replace(/^# .*$(?:\r?\n)*/m, "");
  for (const heading of ["Current Summary", "Prompt", "Rules", "\u9810\u89BD", "Detail", "Visual References", "Working Findings", "New Findings"]) leftover = removeSection(leftover, heading);
  return noteBody(title, summary, prompt, rules, preview, detail, "", newFindings, leftover);
}
function withReferenceLinks(body, fm) {
  const sources = Array.isArray(fm["source-notes"]) ? fm["source-notes"].map(String).filter(Boolean) : [];
  const relationships = Array.isArray(fm["agent-map-references"]) ? fm["agent-map-references"].map(String).filter((text) => text.includes("[[")) : [];
  const links = [...relationships, ...sources.map((path) => `\u4F86\u6E90\u8B70\u984C\uFF1A[[${noteLink(path)}]]`)];
  const clean = withoutReference(body).trimEnd();
  return links.length ? `${clean}

${REFERENCE_START}
## Reference Links

${[...new Set(links)].map((link) => `- ${link}`).join("\n")}
${REFERENCE_END}
` : `${clean}
`;
}
function noteLink(path) {
  return path.replace(/\.md$/, "").replace(/\|/g, "\\|");
}
var Repository = class {
  constructor(app, settings) {
    this.app = app;
    this.settings = settings;
  }
  file(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof import_obsidian3.TFile)) throw new Error(`\u627E\u4E0D\u5230\u6A94\u6848\uFF1A${path}`);
    return file;
  }
  async folder(path) {
    let current = "";
    for (const part of (0, import_obsidian3.normalizePath)(path).split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }
  unique(folder, name) {
    const base = (0, import_obsidian3.normalizePath)(`${folder}/${safeName(name)}`);
    let path = `${base}.md`, number = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${base} ${number++}.md`;
    return path;
  }
  uniqueFolder(folder, name) {
    const base = (0, import_obsidian3.normalizePath)(`${folder}/${safeName(name)}`);
    let path = base, number = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${base} ${number++}`;
    return path;
  }
  topicRoot(mapPath) {
    return parentPath(mapPath);
  }
  topicFolder(mapPath, collection) {
    return `${this.topicRoot(mapPath)}/${collection}`;
  }
  async ensureTopicFolders(root) {
    await this.folder(root);
    for (const name of ["Notes", "Unassigned", "Archive"]) await this.folder(`${root}/${name}`);
  }
  async readNote(path) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const file = this.file(path), content = await this.app.vault.read(file), fm = frontmatter(content);
    const status = String((_a = fm.status) != null ? _a : "idea");
    const normalized = status === "review" || status === "accepted" ? "completed" : status;
    const source = String((_b = fm["model-source"]) != null ? _b : "workspace");
    const state = String((_c = fm["topic-state"]) != null ? _c : path.includes("/Archive/") ? "archived" : path.includes("/Unassigned/") ? "unassigned" : path.startsWith(`${this.settings.inboxFolder}/`) ? "inbox" : "active");
    return {
      title: String((_d = fm.title) != null ? _d : file.basename),
      summary: section(content, "Current Summary") || String((_e = fm.summary) != null ? _e : "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6"),
      prompt: section(content, "Prompt"),
      rules: section(content, "Rules"),
      detail: section(content, "Detail"),
      visualReferences: section(content, "Visual References"),
      newFindings: section(content, "Working Findings") || section(content, "New Findings"),
      preview: [section(content, "\u9810\u89BD"), section(content, "User Notes")].filter(Boolean).join("\n\n"),
      model: String((_f = fm.model) != null ? _f : this.settings.cliModel),
      modelSource: ["workspace", "inherited", "manual"].includes(source) ? source : "workspace",
      status: ["idea", "running", "completed", "error"].includes(normalized) ? normalized : "idea",
      mapId: String((_g = fm["agent-map-id"]) != null ? _g : ""),
      topicId: String((_i = (_h = fm["topic-id"]) != null ? _h : fm["agent-map-id"]) != null ? _i : ""),
      topicState: ["active", "unassigned", "archived", "inbox"].includes(state) ? state : "active",
      sourcePaths: Array.isArray(fm["source-notes"]) ? fm["source-notes"].map(String).filter(Boolean) : []
    };
  }
  async updateNote(path, patch) {
    await this.app.vault.process(this.file(path), (content) => {
      var _a, _b;
      const fm = frontmatter(content);
      ensureNoteCssClass(fm);
      for (const key of ["title", "summary", "model", "status"]) if (patch[key] !== void 0) fm[key] = patch[key];
      if (patch.modelSource !== void 0) fm["model-source"] = patch.modelSource;
      if (patch.mapId !== void 0) patch.mapId ? fm["agent-map-id"] = patch.mapId : delete fm["agent-map-id"];
      if (patch.topicId !== void 0) patch.topicId ? fm["topic-id"] = patch.topicId : delete fm["topic-id"];
      if (patch.topicState !== void 0) fm["topic-state"] = patch.topicState;
      if (patch.sourcePaths !== void 0) patch.sourcePaths.length ? fm["source-notes"] = patch.sourcePaths : delete fm["source-notes"];
      fm.updated = (/* @__PURE__ */ new Date()).toISOString();
      let body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
      body = ensurePreview(body);
      if (patch.title !== void 0) body = body.replace(/^# .*$/m, `# ${patch.title.replace(/\n/g, " ")}`);
      if (patch.summary !== void 0) body = replaceSummarySection(body, patch.summary);
      if (patch.prompt !== void 0) body = replaceSection(body, "Prompt", patch.prompt);
      if (patch.rules !== void 0) body = replaceSection(body, "Rules", patch.rules);
      if (patch.detail !== void 0) body = replaceSection(body, "Detail", patch.detail);
      if (patch.visualReferences !== void 0) {
        body = removeSection(body, "Visual References");
        if (patch.visualReferences.trim()) body = replaceSection(body, "Detail", detailWithVisualReferences(section(body, "Detail"), patch.visualReferences));
      }
      if (patch.newFindings !== void 0) {
        if (patch.newFindings.trim()) body = replaceSection(body, "Working Findings", patch.newFindings);
        else {
          body = removeSection(body, "Working Findings");
          body = removeSection(body, "New Findings");
        }
      }
      if (patch.preview !== void 0) {
        body = replaceSection(body, "\u9810\u89BD", patch.preview);
        fm["preview-initialized"] = true;
      } else if (patch.summary !== void 0 && patch.summary.trim() && patch.summary !== "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6" && fm["preview-initialized"] !== true) {
        const preview = section(body, "\u9810\u89BD").trim();
        if (!preview || preview === "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6") body = replaceSection(body, "\u9810\u89BD", initialPreview(patch.summary, section(body, "Detail")));
        fm["preview-initialized"] = true;
      }
      body = normalizeBodyOrder(body, String((_a = fm.title) != null ? _a : path.replace(/\.md$/, "")), String((_b = fm.summary) != null ? _b : "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6"));
      return `---
${(0, import_obsidian3.stringifyYaml)(fm)}---
${withReferenceLinks(body, fm)}`;
    });
  }
  async createNote(title, model, map, mapPath, modelSource) {
    const folder = this.topicFolder(mapPath, "Notes");
    await this.ensureTopicFolders(this.topicRoot(mapPath));
    const id = crypto.randomUUID(), path = this.unique(folder, title);
    const metadata = {
      "agent-map-node": true,
      "node-id": id,
      "topic-id": map.id,
      "topic-state": "active",
      "agent-map-id": map.id,
      title,
      summary: "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6",
      "preview-initialized": false,
      model,
      "model-source": modelSource,
      status: "idea",
      cssclasses: [NOTE_CSS_CLASS]
    };
    await this.app.vault.create(path, `---
${(0, import_obsidian3.stringifyYaml)(metadata)}---
${noteBody(title, "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6")}`);
    return { id, path, parentId: null, x: 80, y: 80, collapsed: false };
  }
  async readMap(path) {
    return parseMap(await this.app.vault.read(this.file(path)));
  }
  async saveMap(path, map) {
    await this.app.vault.process(this.file(path), (content) => {
      parseMap(content);
      return content.replace(/^# .*$/m, () => `# ${map.title.replace(/\n/g, " ")}`).replace(/```agent-map\s*\n[\s\S]*?\n```/, () => `\`\`\`agent-map
${JSON.stringify(map, null, 2)}
\`\`\``);
    });
  }
  async mapFiles() {
    var _a, _b;
    const files = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cached = (_b = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter) == null ? void 0 : _b["visual-agent-map"];
      if (marker(cached) || /^---\r?\n[\s\S]*?visual-agent-map: true\r?\n/.test(await this.app.vault.cachedRead(file))) files.push(file);
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  async topics() {
    const topics = [];
    for (const file of await this.mapFiles()) {
      const map = await this.readMap(file.path);
      topics.push({ id: map.id, title: map.title, mapPath: file.path, root: this.topicRoot(file.path) });
    }
    return topics;
  }
  async brokenTopics() {
    const root = this.app.vault.getAbstractFileByPath(this.settings.topicsFolder);
    if (!(root instanceof import_obsidian3.TFolder)) return [];
    const broken = [];
    for (const child of root.children) {
      if (!(child instanceof import_obsidian3.TFolder) || this.app.vault.getAbstractFileByPath(`${child.path}/Map.md`)) continue;
      const prefix = `${child.path}/Notes/`;
      const noteCount = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix)).length;
      broken.push({ title: child.name, root: child.path, noteCount });
    }
    return broken.sort((a, b) => a.title.localeCompare(b.title));
  }
  async rebuildMissingMap(root) {
    const path = `${root}/Map.md`;
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error("\u9019\u500B\u4E3B\u984C\u5DF2\u6709 Map.md\u3002");
    const files = this.app.vault.getMarkdownFiles().filter((file) => {
      var _a, _b;
      return file.path.startsWith(`${root}/Notes/`) && marker((_b = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter) == null ? void 0 : _b["agent-map-node"]);
    });
    const first = files[0] ? await this.readNote(files[0].path) : null, id = (first == null ? void 0 : first.topicId) || crypto.randomUUID();
    const nodes = files.map((file, index) => ({ id: crypto.randomUUID(), path: file.path, parentId: null, x: 80 + Math.floor(index / 6) * 340, y: 80 + index % 6 * 220, collapsed: false }));
    const map = { version: 1, id, title: baseName(root), nodes, viewport: { x: 40, y: 40, zoom: 1 } };
    await this.app.vault.create(path, serializeMap(map));
    for (const file of files) await this.setLifecycle(file.path, id, id, "active");
    await this.rebuildDerivedData();
    return path;
  }
  async relinkMissingMap(root, sourcePath) {
    const target = `${root}/Map.md`;
    if (this.app.vault.getAbstractFileByPath(target)) throw new Error("\u9019\u500B\u4E3B\u984C\u5DF2\u6709 Map.md\u3002");
    const map = await this.readMap(sourcePath), candidates = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${root}/Notes/`));
    const byId = /* @__PURE__ */ new Map();
    for (const file of candidates) {
      const fm = frontmatter(await this.app.vault.read(file));
      if (fm["node-id"]) byId.set(String(fm["node-id"]), file.path);
    }
    for (const node of map.nodes) if (!(this.app.vault.getAbstractFileByPath(node.path) instanceof import_obsidian3.TFile) && byId.has(node.id)) node.path = byId.get(node.id);
    await this.moveExact(sourcePath, target);
    await this.saveMap(target, map);
    for (const node of map.nodes) if (this.app.vault.getAbstractFileByPath(node.path) instanceof import_obsidian3.TFile) await this.setLifecycle(node.path, map.id, map.id, "active");
    await this.rebuildDerivedData();
    return target;
  }
  async assignedNotePaths(exceptMapId) {
    const assigned = /* @__PURE__ */ new Set();
    for (const file of await this.mapFiles()) {
      const map = await this.readMap(file.path);
      if (map.id === exceptMapId) continue;
      for (const node of map.nodes) assigned.add(node.path);
    }
    return assigned;
  }
  async collectionFiles(mapPath, collection) {
    const prefix = `${this.topicFolder(mapPath, collection)}/`;
    return this.app.vault.getMarkdownFiles().filter((file) => {
      var _a, _b;
      return file.path.startsWith(prefix) && marker((_b = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter) == null ? void 0 : _b["agent-map-node"]);
    }).sort((a, b) => a.basename.localeCompare(b.basename));
  }
  async inboxFiles() {
    const prefix = `${this.settings.inboxFolder}/`;
    return this.app.vault.getMarkdownFiles().filter((file) => {
      var _a, _b;
      return file.path.startsWith(prefix) && marker((_b = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter) == null ? void 0 : _b["agent-map-node"]);
    }).sort((a, b) => a.basename.localeCompare(b.basename));
  }
  async moveUnique(path, folder) {
    await this.folder(folder);
    const file = this.file(path), desired = (0, import_obsidian3.normalizePath)(`${folder}/${baseName(path)}`);
    const target = this.app.vault.getAbstractFileByPath(desired) ? this.unique(folder, file.basename) : desired;
    await this.app.fileManager.renameFile(file, target);
    await this.replaceSourcePath(path, target);
    return target;
  }
  async moveExact(path, target) {
    await this.folder(parentPath(target));
    if (this.app.vault.getAbstractFileByPath(target)) throw new Error(`\u76EE\u6A19\u6A94\u6848\u5DF2\u5B58\u5728\uFF1A${target}`);
    await this.app.fileManager.renameFile(this.file(path), target);
    await this.replaceSourcePath(path, target);
  }
  async renameNote(path, title, exactTarget) {
    await this.updateNote(path, { title });
    const folder = parentPath(path), desired = exactTarget != null ? exactTarget : (0, import_obsidian3.normalizePath)(`${folder}/${safeName(title)}.md`);
    if (desired === path) return path;
    const target = exactTarget != null ? exactTarget : this.app.vault.getAbstractFileByPath(desired) ? this.unique(folder, title) : desired;
    await this.app.fileManager.renameFile(this.file(path), target);
    await this.replaceSourcePath(path, target);
    return target;
  }
  async replaceSourcePath(oldPath, newPath) {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const note = await this.readNoteIfManaged(file);
      if (!(note == null ? void 0 : note.sourcePaths.includes(oldPath))) continue;
      await this.updateNote(file.path, { sourcePaths: note.sourcePaths.map((path) => path === oldPath ? newPath : path) });
    }
  }
  async readNoteIfManaged(file) {
    const content = await this.app.vault.read(file), fm = frontmatter(content);
    return marker(fm["agent-map-node"]) ? this.readNote(file.path) : null;
  }
  async normalizeGeneratedNoteFilenames() {
    let renamed = 0;
    for (const mapFile of await this.mapFiles()) {
      const map = await this.readMap(mapFile.path);
      let changed = false;
      for (const node of map.nodes) {
        const file = this.app.vault.getAbstractFileByPath(node.path);
        if (!(file instanceof import_obsidian3.TFile) || !/^新的子議題(?: \d+)*$/.test(file.basename)) continue;
        const note = await this.readNote(node.path);
        if (!note.title.trim() || safeName(note.title) === file.basename) continue;
        const oldPath = node.path, newPath = await this.renameNote(oldPath, note.title);
        node.path = newPath;
        changed = true;
        renamed++;
        await this.replaceSourcePath(oldPath, newPath);
      }
      if (changed) await this.saveMap(mapFile.path, map);
    }
    for (const file of [...this.app.vault.getMarkdownFiles()]) {
      if (!/^新的子議題(?: \d+)*$/.test(file.basename)) continue;
      const note = await this.readNoteIfManaged(file);
      if (!note || !note.title.trim() || safeName(note.title) === file.basename) continue;
      const oldPath = file.path, newPath = await this.renameNote(oldPath, note.title);
      await this.replaceSourcePath(oldPath, newPath);
      renamed++;
    }
    if (renamed) await this.rebuildDerivedData();
    return renamed;
  }
  async setLifecycle(path, topicId, mapId, state) {
    await this.updateNote(path, { topicId, mapId, topicState: state });
  }
  async rebuildDerivedData() {
    var _a, _b, _c, _d;
    const ownership = /* @__PURE__ */ new Map();
    const topics = /* @__PURE__ */ new Map();
    for (const mapFile of await this.mapFiles()) {
      const map = await this.readMap(mapFile.path);
      topics.set(map.id, { map, mapPath: mapFile.path });
      for (const node of map.nodes) {
        const existing = ownership.get(node.path);
        if (existing && existing.map.id !== map.id) throw new Error(`\u8B70\u984C\u7B46\u8A18\u540C\u6642\u51FA\u73FE\u5728\u5169\u5F35\u5FC3\u667A\u5716\uFF1A${node.path}`);
        ownership.set(node.path, { map, mapPath: mapFile.path, node });
      }
    }
    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.read(file), fm = frontmatter(content);
      if (!marker(fm["agent-map-node"])) continue;
      ensureNoteCssClass(fm);
      const owner = ownership.get(file.path);
      let state = file.path.startsWith(`${this.settings.inboxFolder}/`) ? "inbox" : file.path.includes("/Archive/") ? "archived" : file.path.includes("/Unassigned/") ? "unassigned" : owner ? "active" : String((_a = fm["topic-state"]) != null ? _a : "unassigned");
      if (owner) {
        fm["agent-map-id"] = owner.map.id;
        fm["topic-id"] = owner.map.id;
        fm["topic-state"] = "active";
        state = "active";
        if (fm["model-source"] === void 0) fm["model-source"] = owner.node.parentId ? "inherited" : "workspace";
      } else {
        delete fm["agent-map-id"];
        if (state === "inbox") {
          delete fm["topic-id"];
          fm["topic-state"] = "inbox";
        } else fm["topic-state"] = state;
      }
      let body = ensurePreview(content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""));
      const topicId = String((_b = fm["topic-id"]) != null ? _b : ""), topic = topics.get(topicId);
      if (owner) {
        if (!body.includes(DETAIL_START)) body = replaceSection(body, "Detail", section(body, "Detail"));
        const parent = owner.node.parentId ? owner.map.nodes.find((item) => item.id === owner.node.parentId) : void 0;
        const children = owner.map.nodes.filter((item) => item.parentId === owner.node.id);
        fm["agent-map-references"] = [
          `\u6240\u5C6C\u4E3B\u984C\uFF1A[[${noteLink(owner.mapPath)}|${owner.map.title}]]`,
          `\u6240\u5C6C\u5FC3\u667A\u5716\uFF1A[[${noteLink(owner.mapPath)}]]`,
          parent ? `\u6BCD\u8B70\u984C\uFF1A[[${noteLink(parent.path)}]]` : "\u6BCD\u8B70\u984C\uFF1A\u7121",
          children.length ? `\u5B50\u8B70\u984C\uFF1A${children.map((child) => `[[${noteLink(child.path)}]]`).join("\u3001")}` : "\u5B50\u8B70\u984C\uFF1A\u7121"
        ];
        body = withoutReference(body);
      } else if (topic && (state === "unassigned" || state === "archived")) {
        fm["agent-map-references"] = [`\u6240\u5C6C\u4E3B\u984C\uFF1A[[${noteLink(topic.mapPath)}|${topic.map.title}]]`, `\u72C0\u614B\uFF1A${state === "archived" ? "\u5DF2\u5C01\u5B58" : "\u672A\u6B78\u985E"}`];
        body = withoutReference(body);
      } else {
        delete fm["agent-map-references"];
        body = withoutReference(body);
      }
      body = normalizeBodyOrder(body, String((_c = fm.title) != null ? _c : file.basename), String((_d = fm.summary) != null ? _d : "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6"));
      const next = `---
${(0, import_obsidian3.stringifyYaml)(fm)}---
${withReferenceLinks(body, fm)}`;
      if (next !== content) await this.app.vault.process(file, () => next);
    }
  }
  async ensureNodePresentation() {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.read(file), fm = frontmatter(content);
      if (!marker(fm["agent-map-node"]) || !ensureNoteCssClass(fm)) continue;
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
      await this.app.vault.process(file, () => `---
${(0, import_obsidian3.stringifyYaml)(fm)}---
${body}`);
    }
  }
  async createMap(title, nodes = []) {
    await this.folder(this.settings.topicsFolder);
    const root = this.uniqueFolder(this.settings.topicsFolder, title);
    await this.ensureTopicFolders(root);
    const path = `${root}/Map.md`;
    const map = { version: 1, id: crypto.randomUUID(), title, nodes, viewport: { x: 40, y: 40, zoom: 1 } };
    await this.app.vault.create(path, serializeMap(map));
    return path;
  }
  async legacyMigrationPlan() {
    const allMaps = await this.mapFiles();
    const legacyMaps = allMaps.filter((file) => !file.path.startsWith(`${this.settings.topicsFolder}/`));
    const assigned = /* @__PURE__ */ new Set(), maps = [];
    const reservedRoots = /* @__PURE__ */ new Set();
    for (const file of legacyMaps) {
      const map = await this.readMap(file.path);
      for (const node of map.nodes) assigned.add(node.path);
      let targetRoot = (0, import_obsidian3.normalizePath)(`${this.settings.topicsFolder}/${safeName(map.title)}`), number = 2;
      const base = targetRoot;
      while (this.app.vault.getAbstractFileByPath(targetRoot) || reservedRoots.has(targetRoot)) targetRoot = `${base} ${number++}`;
      reservedRoots.add(targetRoot);
      maps.push({ oldPath: file.path, title: map.title, targetRoot, notePaths: map.nodes.map((node) => node.path) });
    }
    const orphanPaths = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = frontmatter(await this.app.vault.read(file));
      if (marker(fm["agent-map-node"]) && !assigned.has(file.path) && !file.path.startsWith(`${this.settings.topicsFolder}/`) && !file.path.startsWith(`${this.settings.inboxFolder}/`)) orphanPaths.push(file.path);
    }
    return { maps, orphanPaths };
  }
  async migrateLegacyWorkspace(plan) {
    const originals = /* @__PURE__ */ new Map(), moves = [], mapPaths = /* @__PURE__ */ new Map();
    const remember = async (path) => {
      if (!originals.has(path)) originals.set(path, await this.app.vault.read(this.file(path)));
    };
    try {
      await this.folder(this.settings.inboxFolder);
      for (const item of plan.maps) {
        await this.ensureTopicFolders(item.targetRoot);
        await remember(item.oldPath);
        const map = await this.readMap(item.oldPath), mapTarget = `${item.targetRoot}/Map.md`;
        await this.moveExact(item.oldPath, mapTarget);
        moves.push({ from: item.oldPath, to: mapTarget });
        mapPaths.set(item.oldPath, mapTarget);
        for (const node of map.nodes) {
          await remember(node.path);
          const old = node.path, next = await this.moveUnique(old, `${item.targetRoot}/Notes`);
          moves.push({ from: old, to: next });
          node.path = next;
          await this.setLifecycle(next, map.id, map.id, "active");
        }
        await this.saveMap(mapTarget, map);
      }
      for (const path of plan.orphanPaths) {
        await remember(path);
        const next = await this.moveUnique(path, this.settings.inboxFolder);
        moves.push({ from: path, to: next });
        await this.setLifecycle(next, "", "", "inbox");
      }
      await this.rebuildDerivedData();
      return mapPaths;
    } catch (error) {
      for (const move of [...moves].reverse()) {
        const current = this.app.vault.getAbstractFileByPath(move.to);
        if (current instanceof import_obsidian3.TFile && !this.app.vault.getAbstractFileByPath(move.from)) await this.app.fileManager.renameFile(current, move.from);
      }
      for (const [path, content] of originals) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof import_obsidian3.TFile) await this.app.vault.process(file, () => content);
      }
      throw error;
    }
  }
  async renameTopic(mapPath, title, targetRoot) {
    const file = this.file(mapPath), root = file.parent;
    if (!(root instanceof import_obsidian3.TFolder) || !mapPath.startsWith(`${this.settings.topicsFolder}/`)) throw new Error("\u820A\u7248\u5FC3\u667A\u5716\u8ACB\u5148\u57F7\u884C\u8CC7\u6599\u6574\u7406\u3002");
    const desired = targetRoot ? (0, import_obsidian3.normalizePath)(targetRoot) : (0, import_obsidian3.normalizePath)(`${this.settings.topicsFolder}/${safeName(title)}`);
    if (desired !== root.path && this.app.vault.getAbstractFileByPath(desired)) throw new Error("\u540C\u540D\u4E3B\u984C\u8CC7\u6599\u593E\u5DF2\u5B58\u5728\u3002");
    const originalRoot = root.path;
    if (desired !== originalRoot) await this.app.fileManager.renameFile(root, desired);
    const next = `${desired}/Map.md`, map = await this.readMap(next);
    map.title = title;
    for (const node of map.nodes) if (node.path.startsWith(`${originalRoot}/`)) node.path = `${desired}/${node.path.slice(originalRoot.length + 1)}`;
    await this.saveMap(next, map);
    await this.rebuildDerivedData();
    return next;
  }
  async migrate() {
  }
};

// ai/context-builder.ts
var estimateTokens = (value) => Math.ceil((value || "").length / 4);
var dedupeRules = (value) => Array.from(new Map(value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => [line.replace(/\s+/g, " ").toLowerCase(), line])).values()).join("\n");
function buildPreparedTaskContext(input, model, budget = 32e3) {
  const started = Date.now(), mode = input.mode || "task";
  const context = { ...input, rules: dedupeRules(input.rules), ancestors: input.ancestors.replace(/^\s*AI 規則：.*(?:\n|$)/gm, "").trim() };
  if (mode === "decompose") {
    context.detail = "";
    context.sourceContext = "";
    context.workingFindings = "";
  }
  if (mode === "task" && context.summary.trim() && !/(延續|修改|既有|原有|更新)/.test(context.task)) context.detail = "";
  const optional = ["sourceContext", "workingFindings", "detail", "ancestors"];
  const used = () => Object.values(context).reduce((sum, value) => sum + (typeof value === "string" ? estimateTokens(value) : 0), 0);
  for (const key of optional) if (used() > budget && context[key]) context[key] = String(context[key]).slice(0, Math.max(0, (budget - used() + estimateTokens(String(context[key]))) * 4));
  const contextBreakdown = { task: estimateTokens(context.task), currentSummary: estimateTokens(context.summary), currentDetail: estimateTokens(context.detail), effectiveRules: estimateTokens(context.rules), ancestors: estimateTokens(context.ancestors), workingFindings: estimateTokens(context.workingFindings), sourceContext: estimateTokens(context.sourceContext) };
  return { context, metrics: { provider: model.startsWith("claude:") ? "claude" : "codex", model, mode, estimatedInputTokens: Object.values(contextBreakdown).reduce((a, b) => a + b, 0), contextBreakdown, contextBuildMs: Date.now() - started, sessionStrategy: "fresh-session-per-node-task" } };
}

// ai/result-utils.ts
var KNOWLEDGE_HEADINGS = ["\u6838\u5FC3\u7D50\u8AD6", "\u95DC\u9375\u77E5\u8B58", "\u8B49\u64DA\u8207\u4F86\u6E90", "\u53D6\u6368\u8207\u9650\u5236", "\u5F85\u78BA\u8A8D\u4E8B\u9805", "\u66F4\u65B0\u7D00\u9304"];
function canonicalDetail(value) {
  const detail = value.trim();
  if (KNOWLEDGE_HEADINGS.every((heading) => new RegExp(`^### ${heading}\\s*$`, "m").test(detail))) return detail;
  const stamp = (/* @__PURE__ */ new Date()).toLocaleDateString("zh-TW");
  return [
    `### \u6838\u5FC3\u7D50\u8AD6

${detail || "\u5C1A\u5F85\u6574\u7406\u3002"}`,
    "### \u95DC\u9375\u77E5\u8B58\n\n\u5C1A\u5F85\u88DC\u5145\u3002",
    "### \u8B49\u64DA\u8207\u4F86\u6E90\n\n\u5C1A\u5F85\u88DC\u5145\u3002",
    "### \u53D6\u6368\u8207\u9650\u5236\n\n\u5C1A\u5F85\u88DC\u5145\u3002",
    "### \u5F85\u78BA\u8A8D\u4E8B\u9805\n\n\u5C1A\u5F85\u88DC\u5145\u3002",
    `### \u66F4\u65B0\u7D00\u9304

- ${stamp}\uFF1A\u6574\u7406\u70BA\u7D50\u69CB\u5316\u77E5\u8B58\u3002`
  ].join("\n\n");
}
function visualReferencesMarkdown(references = []) {
  return references.map((item) => {
    const title = item.title.trim() || "\u8996\u89BA\u53C3\u8003";
    const imageUrl = item.imageUrl.trim();
    const sourceUrl = item.sourceUrl.trim();
    if (!imageUrl || !sourceUrl) return "";
    const palette = item.palette.map((color) => color.trim()).filter(Boolean).join(" / ");
    return [
      `**${title}**`,
      "",
      `![${title}](${imageUrl})`,
      "",
      `\u4F86\u6E90\uFF1A${sourceUrl}`,
      item.description.trim() ? `\u7528\u9014\uFF1A${item.description.trim()}` : "",
      palette ? `\u914D\u8272\uFF1A${palette}` : "",
      item.formula.trim() ? `\u53EF\u5957\u7528\u516C\u5F0F\uFF1A${item.formula.trim()}` : ""
    ].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n");
}

// ai/provider-registry.ts
var ProviderRegistry = class {
  constructor(codex, claude) {
    this.codex = codex;
    this.claude = claude;
  }
  select(model) {
    return model.startsWith("claude:") ? this.claude : this.codex;
  }
  modelFor(provider, model) {
    return provider.id === "claude" ? model.slice("claude:".length) : model;
  }
};

// ui/preview-utils.ts
function clampPreviewScale(value) {
  const scale = typeof value === "number" ? value : Number(value);
  return Number.isFinite(scale) ? Math.max(80, Math.min(240, Math.round(scale))) : 120;
}
function legacyPreviewScale(value) {
  return value === "small" ? 90 : value === "large" ? 160 : 120;
}
function previewMetrics(scaleValue) {
  const scale = clampPreviewScale(scaleValue) / 120;
  return { min: Math.round(240 * scale), max: Math.round(320 * scale), height: Math.round(420 * scale), image: `${Math.round(150 * scale)}px`, title: `${Math.round(15 * scale)}px`, body: `${Math.round(13 * scale)}px`, labelSize: `${Math.round(11 * scale)}px`, table: `${Math.round(11 * scale)}px`, line: String(Math.max(1.3, Math.min(1.75, 1.45 + (scale - 1) * 0.18))), padding: `${Math.round(14 * scale)}px ${Math.round(16 * scale)}px` };
}
function markdownImages(markdown, limit = 4) {
  const images = [];
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi)) {
    images.push({ alt: match[1] || "\u8996\u89BA\u53C3\u8003", url: match[2] });
    if (images.length >= limit) break;
  }
  return images;
}
function firstMarkdownImage(markdown) {
  var _a;
  return (_a = markdownImages(markdown, 1)[0]) != null ? _a : null;
}
function firstMarkdownTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|.+\|\s*$/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const rows = [];
    for (let j = i; j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j]); j++) {
      if (j === i + 1) continue;
      rows.push(lines[j].trim().slice(1, -1).split("|").map((cell) => cell.trim()).filter(Boolean));
      if (rows.length >= 4) break;
    }
    return rows.filter((row) => row.length);
  }
  return [];
}

// main.ts
var VIEW_TYPE = "visual-agent-map-view";
var AcpTransportError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AcpTransportError";
  }
};
var AcpTimeoutError = class extends Error {
  constructor(method, timeoutMs) {
    super(`Codex ACP ${method} \u5728 ${Math.ceil(timeoutMs / 1e3)} \u79D2\u5167\u6C92\u6709\u56DE\u61C9`);
    this.name = "AcpTimeoutError";
  }
};
var AcpSessionError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AcpSessionError";
  }
};
var AcpModelError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AcpModelError";
  }
};
var AcpParseError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AcpParseError";
  }
};
var ACP_CONTROL_TIMEOUT_MS = 3e4;
var ACP_PROMPT_TIMEOUT_MS = 15 * 60 * 1e3;
var labels = { idea: t("\u5F85\u7814\u7A76"), running: t("AI \u57F7\u884C\u4E2D"), completed: t("AI \u5B8C\u6210"), error: t("\u57F7\u884C\u932F\u8AA4") };
var FirstUseModal = class extends import_obsidian4.Modal {
  constructor(app, complete) {
    super(app);
    this.complete = complete;
  }
  onOpen() {
    this.titleEl.setText("\u958B\u59CB\u4F7F\u7528 Visual Agent Map");
    this.contentEl.createEl("p", { text: "Visual Agent Map \u7684 Codex \u6A21\u578B\u53EA\u6703\u4F7F\u7528\u4F60\u7684 Codex \u6D41\u91CF\uFF0C\u4E0D\u6703\u4F7F\u7528 ChatGPT \u6D41\u91CF\u3002\u4F7F\u7528\u524D\uFF0C\u8ACB\u5148\u5728\u9019\u53F0\u96FB\u8166\u767B\u5165\u65E2\u6709\u7684 ChatGPT \u5E33\u865F\u8207 Codex CLI\u3002", cls: "vam-modal-intro" });
    this.contentEl.createEl("p", { text: "\u53EA\u6709\u5728\u4F60\u78BA\u8A8D\u57F7\u884C AI \u4EFB\u52D9\u6642\uFF0C\u5916\u639B\u624D\u6703\u628A\u76EE\u524D\u8B70\u984C\u53CA\u5FC5\u8981\u8108\u7D61\u4EA4\u7D66\u672C\u6A5F Codex \u5DE5\u5177\u8655\u7406\uFF1B\u5916\u639B\u4E0D\u6703\u4FDD\u5B58 API key\u3002" });
    new import_obsidian4.Setting(this.contentEl).addButton((button) => button.setButtonText("\u6211\u4E86\u89E3\uFF0C\u958B\u59CB\u4F7F\u7528").setCta().onClick(() => this.close()));
  }
  onClose() {
    this.complete();
  }
};
var TaskModal = class extends import_obsidian4.Modal {
  constructor(app, value, submit, titleText = t("\u81EA\u8A02 AI \u4EFB\u52D9"), description = t("\u63CF\u8FF0\u9019\u4E00\u6B65\u8981\u8ACB AI \u5B8C\u6210\u4EC0\u9EBC\u3002"), rules = "") {
    super(app);
    this.value = value;
    this.submit = submit;
    this.titleText = titleText;
    this.description = description;
    this.rules = rules;
  }
  onOpen() {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.description, cls: "vam-modal-intro" });
    const rulePreview = this.contentEl.createDiv("vam-rule-preview");
    rulePreview.createEl("strong", { text: t("\u672C\u6B21\u5957\u7528\u7684 AI \u898F\u5247") });
    rulePreview.createEl("p", { text: this.rules.trim() || t("\u672A\u8A2D\u5B9A\u984D\u5916\u898F\u5247\u3002") });
    const input = this.contentEl.createEl("textarea", { text: this.value, cls: "vam-task-input" });
    input.rows = 7;
    input.setAttr("aria-label", t("\u81EA\u8A02 AI \u4EFB\u52D9"));
    const save = (run) => {
      const value = input.value.trim();
      if (!value) return;
      this.close();
      this.submit(value, run);
    };
    new import_obsidian4.Setting(this.contentEl).addButton((b) => b.setButtonText(t("\u53D6\u6D88")).onClick(() => this.close())).addButton((b) => b.setButtonText(t("\u53EA\u5132\u5B58")).onClick(() => save(false))).addButton((b) => b.setButtonText(t("\u78BA\u8A8D\u4E26\u57F7\u884C")).setCta().onClick(() => save(true)));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
};
var ChildProposalModal = class extends import_obsidian4.Modal {
  constructor(app, suggestions, submit) {
    super(app);
    this.suggestions = suggestions;
    this.submit = submit;
  }
  onOpen() {
    this.titleEl.setText(t("AI \u5B50\u8B70\u984C\u63D0\u6848"));
    this.contentEl.createEl("p", { text: t("\u52FE\u9078\u8981\u5EFA\u7ACB\u7684\u5B50\u8B70\u984C\uFF1B\u5EFA\u7ACB\u524D\u53EF\u76F4\u63A5\u4FEE\u6539\u540D\u7A31\u8207\u4EFB\u52D9\u3002") });
    const rows = [];
    for (const item of this.suggestions) {
      const row = this.contentEl.createDiv("vam-proposal");
      const check = row.createEl("input", { type: "checkbox" });
      check.checked = true;
      const title = row.createEl("input", { type: "text", value: item.title });
      const task = row.createEl("textarea", { text: item.task });
      task.rows = 2;
      const contribution = row.createEl("textarea", { text: item.contribution });
      contribution.rows = 2;
      contribution.placeholder = t("\u5C0D\u6BCD\u8B70\u984C\u7684\u8CA2\u737B");
      rows.push({ check, title, task, contribution });
    }
    new import_obsidian4.Setting(this.contentEl).addButton((b) => b.setButtonText(t("\u53D6\u6D88")).onClick(() => this.close())).addButton((b) => b.setButtonText(t("\u5EFA\u7ACB\u5B50\u8B70\u984C")).setCta().onClick(() => {
      this.close();
      this.submit(rows.filter((row) => row.check.checked && row.title.value.trim()).map((row) => ({ title: row.title.value.trim(), task: row.task.value.trim(), contribution: row.contribution.value.trim() })));
    }));
  }
};
var IntegrationModal = class extends import_obsidian4.Modal {
  constructor(app, names, defaultRules, submit) {
    super(app);
    this.names = names;
    this.defaultRules = defaultRules;
    this.submit = submit;
  }
  onOpen() {
    this.titleEl.setText(t("\u78BA\u8A8D\u6574\u5408\u8B70\u984C"));
    this.contentEl.createEl("p", { text: t("\u5C07\u6574\u5408 {0} \u500B\u4F86\u6E90\u8B70\u984C\uFF0CAI \u6703\u8B80\u53D6\u5B8C\u6574\u77E5\u8B58\u5167\u5BB9\u4E26\u5EFA\u7ACB\u65B0\u7684\u6839\u8B70\u984C\u3002", this.names.length), cls: "vam-modal-intro" });
    const sources = this.contentEl.createDiv("vam-integration-sources");
    sources.createEl("strong", { text: t("\u4F86\u6E90\u8B70\u984C") });
    for (const name of this.names) sources.createDiv({ text: name });
    const titleLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    titleLabel.createSpan({ text: t("\u65B0\u8B70\u984C\u540D\u7A31") });
    const title = titleLabel.createEl("input", { type: "text", value: t("\u6574\u5408\u8B70\u984C") });
    title.setAttr("aria-label", t("\u65B0\u8B70\u984C\u540D\u7A31"));
    const goalLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    goalLabel.createSpan({ text: t("\u6574\u5408\u76EE\u6A19") });
    const goal = goalLabel.createEl("textarea", { text: t("\u627E\u51FA\u5171\u540C\u7D50\u8AD6\u3001\u91CD\u8981\u5DEE\u7570\u3001\u53D6\u6368\u8207\u4E0B\u4E00\u6B65\u3002") });
    goal.rows = 4;
    goal.setAttr("aria-label", t("\u6574\u5408\u76EE\u6A19"));
    const rulesLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    rulesLabel.createSpan({ text: t("AI \u898F\u5247") });
    const rules = rulesLabel.createEl("textarea", { text: this.defaultRules });
    rules.rows = 3;
    rules.setAttr("aria-label", t("AI \u898F\u5247"));
    const save = () => {
      if (!title.value.trim() || !goal.value.trim()) return;
      this.close();
      this.submit(title.value.trim(), goal.value.trim(), rules.value.trim());
    };
    new import_obsidian4.Setting(this.contentEl).addButton((button) => button.setButtonText(t("\u53D6\u6D88")).onClick(() => this.close())).addButton((button) => button.setButtonText(t("\u78BA\u8A8D\u4E26\u57F7\u884C")).setCta().onClick(save));
    title.focus();
    title.select();
  }
};
var ConflictModal = class extends import_obsidian4.Modal {
  constructor(app, label, local, disk, resolve) {
    super(app);
    this.label = label;
    this.local = local;
    this.disk = disk;
    this.resolve = resolve;
  }
  onOpen() {
    this.titleEl.setText(t("{0}\u6709\u5916\u90E8\u4FEE\u6539", this.label));
    this.contentEl.createEl("p", { text: t("\u756B\u9762\u8207 Markdown \u90FD\u6709\u4FEE\u6539\u3002\u8ACB\u9078\u64C7\u8981\u4FDD\u7559\u7684\u5167\u5BB9\uFF0C\u6216\u5728\u4E0B\u65B9\u624B\u52D5\u5408\u4F75\u3002") });
    const input = this.contentEl.createEl("textarea", { cls: "vam-task-input", text: `${this.disk}

${this.local}` });
    input.rows = 10;
    new import_obsidian4.Setting(this.contentEl).addButton((b) => b.setButtonText(t("\u4F7F\u7528\u6A94\u6848\u5167\u5BB9")).onClick(() => {
      this.close();
      this.resolve(null);
    })).addButton((b) => b.setButtonText(t("\u4FDD\u7559\u756B\u9762\u5167\u5BB9")).onClick(() => {
      this.close();
      this.resolve(this.local);
    })).addButton((b) => b.setButtonText(t("\u5132\u5B58\u5408\u4F75\u5167\u5BB9")).setCta().onClick(() => {
      this.close();
      this.resolve(input.value.trim());
    }));
  }
};
var MapConflictModal = class extends import_obsidian4.Modal {
  constructor(app, local, disk, resolve) {
    super(app);
    this.local = local;
    this.disk = disk;
    this.resolve = resolve;
    __publicField(this, "settled", false);
  }
  onOpen() {
    this.titleEl.setText(t("\u5FC3\u667A\u5716\u6709\u5916\u90E8\u4FEE\u6539"));
    this.contentEl.createEl("p", { text: t("\u756B\u9762\u8207 Map.md \u7684\u7D50\u69CB\u90FD\u5DF2\u6539\u8B8A\u3002\u53EF\u9078\u64C7\u5176\u4E2D\u4E00\u7248\uFF0C\u6216\u7DE8\u8F2F\u4E0B\u65B9 JSON \u5F8C\u624B\u52D5\u5408\u4F75\u3002") });
    const input = this.contentEl.createEl("textarea", { cls: "vam-task-input", text: JSON.stringify(this.disk, null, 2) });
    input.rows = 16;
    const finish = (map) => {
      this.settled = true;
      this.close();
      this.resolve(map);
    };
    new import_obsidian4.Setting(this.contentEl).addButton((button) => button.setButtonText(t("\u4F7F\u7528\u6A94\u6848\u5167\u5BB9")).onClick(() => finish(clone(this.disk)))).addButton((button) => button.setButtonText(t("\u4FDD\u7559\u756B\u9762\u5167\u5BB9")).onClick(() => finish(clone(this.local)))).addButton((button) => button.setButtonText(t("\u5132\u5B58\u5408\u4F75\u5167\u5BB9")).setCta().onClick(() => {
      try {
        finish(parseMap(serializeMap(JSON.parse(input.value))));
      } catch (error) {
        new import_obsidian4.Notice(error instanceof Error ? t("\u5408\u4F75\u5167\u5BB9\u7121\u6548\uFF1A{0}", error.message) : t("\u5408\u4F75\u5167\u5BB9\u7121\u6548\u3002"));
      }
    }));
  }
  onClose() {
    if (!this.settled) this.resolve(clone(this.disk));
  }
};
var NoteCollectionModal = class extends import_obsidian4.Modal {
  constructor(app, titleText, files, actions) {
    super(app);
    this.titleText = titleText;
    this.files = files;
    this.actions = actions;
  }
  onOpen() {
    this.titleEl.setText(this.titleText);
    if (!this.files.length) this.contentEl.createEl("p", { text: t("\u76EE\u524D\u6C92\u6709\u7B46\u8A18\u3002") });
    for (const file of this.files) {
      const row = this.contentEl.createDiv("vam-collection-row");
      row.createSpan({ text: file.basename });
      const actions = row.createDiv("vam-collection-actions");
      for (const action of this.actions) actions.createEl("button", { text: action.label }).addEventListener("click", () => {
        this.close();
        action.run(file);
      });
    }
    new import_obsidian4.Setting(this.contentEl).addButton((button) => button.setButtonText(t("\u95DC\u9589")).onClick(() => this.close()));
  }
};
var TopicPickerModal = class extends import_obsidian4.Modal {
  constructor(app, titleText, topics, choose) {
    super(app);
    this.titleText = titleText;
    this.topics = topics;
    this.choose = choose;
  }
  onOpen() {
    this.titleEl.setText(this.titleText);
    for (const topic of this.topics) new import_obsidian4.Setting(this.contentEl).setName(topic.title).setDesc(topic.root).addButton((button) => button.setButtonText(t("\u9078\u64C7")).onClick(() => {
      this.close();
      this.choose(topic);
    }));
    if (!this.topics.length) this.contentEl.createEl("p", { text: t("\u6C92\u6709\u5176\u4ED6\u4E3B\u984C\u3002") });
    new import_obsidian4.Setting(this.contentEl).addButton((button) => button.setButtonText(t("\u53D6\u6D88")).onClick(() => this.close()));
  }
};
var VisualAgentMapView = class extends import_obsidian4.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    __publicField(this, "map", null);
    __publicField(this, "path", "");
    __publicField(this, "notes", /* @__PURE__ */ new Map());
    __publicField(this, "selected", null);
    __publicField(this, "multiSelected", /* @__PURE__ */ new Set());
    __publicField(this, "history", new History());
    __publicField(this, "viewportEl", null);
    __publicField(this, "stageEl", null);
    __publicField(this, "edgesEl", null);
    __publicField(this, "zoomLabel", null);
    __publicField(this, "refreshTimer", null);
    __publicField(this, "viewportTimer", null);
    __publicField(this, "hoverTimer", null);
    __publicField(this, "hoverCard", null);
    __publicField(this, "integrationMode", false);
    __publicField(this, "dragging", false);
    __publicField(this, "suppressClickUntil", 0);
    __publicField(this, "closed", false);
    __publicField(this, "headerTitle", "");
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    var _a, _b;
    return (_b = (_a = this.map) == null ? void 0 : _a.title) != null ? _b : "Visual Agent Map";
  }
  getIcon() {
    return "git-fork";
  }
  getState() {
    return { file: this.path };
  }
  async setState(state, result) {
    if (typeof state.file === "string" && state.file !== this.path) await this.openMap(state.file);
    await super.setState(state, result);
  }
  async onOpen() {
    this.contentEl.addClass("vam-view");
    this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        this.enqueue(() => this.travel(event.shiftKey));
      }
      if (event.key === "Escape") {
        this.selected = null;
        this.multiSelected.clear();
        this.integrationMode = false;
        this.render();
      }
    });
    await this.plugin.ready;
    if (!this.path) {
      const files = await this.plugin.repo.mapFiles();
      if (files.length) await this.openMap(files[0].path);
      else this.render();
    }
  }
  async onClose() {
    var _a;
    this.closed = true;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    (_a = this.hoverCard) == null ? void 0 : _a.remove();
    if (this.viewportTimer !== null) {
      window.clearTimeout(this.viewportTimer);
      await this.persist();
    }
  }
  async refreshFromPlugin() {
    await this.hydrate();
    this.render();
  }
  enqueue(work) {
    void this.plugin.mutate(work).catch(() => {
    });
  }
  async persist() {
    if (this.map && this.path) await this.plugin.repo.saveMap(this.path, this.map);
  }
  async hydrate() {
    var _a, _b;
    this.notes.clear();
    for (const node of (_b = (_a = this.map) == null ? void 0 : _a.nodes) != null ? _b : []) {
      try {
        this.notes.set(node.id, await this.plugin.repo.readNote(node.path));
      } catch (e) {
      }
    }
  }
  async openMap(path) {
    if (this.viewportTimer !== null) {
      window.clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
      await this.persist();
    }
    const map = await this.plugin.repo.readMap(path);
    this.path = path;
    this.map = map;
    this.integrationMode = false;
    this.selected = null;
    this.multiSelected.clear();
    this.history.clear();
    await this.hydrate();
    this.render();
    this.app.workspace.requestSaveLayout();
  }
  changed(file) {
    var _a;
    if (file.path !== this.path && !((_a = this.map) == null ? void 0 : _a.nodes.some((node) => node.path === file.path))) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      var _a2;
      if (this.closed) return;
      if (this.dragging) {
        this.changed(file);
        return;
      }
      if (this.contentEl.contains(document.activeElement) && ((_a2 = document.activeElement) == null ? void 0 : _a2.matches("input, textarea, select"))) {
        this.changed(file);
        return;
      }
      this.enqueue(async () => {
        if (file.path === this.path) {
          this.map = await this.plugin.repo.readMap(this.path);
          this.history.clear();
          await this.plugin.rebuildDerivedData();
        }
        await this.hydrate();
        this.render();
      });
    }, 400);
  }
  async renamed(file, oldPath) {
    if (this.path === oldPath) this.path = file.path;
    if (this.map) {
      for (const node of this.map.nodes) if (node.path === oldPath) node.path = file.path;
      this.history.clear();
      await this.hydrate();
      this.render();
    }
  }
  deleted(file) {
    if (file.path === this.path) {
      this.map = null;
      this.path = "";
      this.history.clear();
      this.render();
    } else this.changed(file);
  }
  button(parent, text, action, disabled = false) {
    const button = parent.createEl("button", { text: t(text) });
    button.disabled = disabled;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      action();
    });
    return button;
  }
  async mapChange(change) {
    if (!this.map) return;
    const path = this.path;
    const disk = await this.plugin.repo.readMap(path);
    const structure = (map) => JSON.stringify({ ...map, viewport: null });
    if (structure(disk) !== structure(this.map)) {
      const local = clone(this.map);
      this.map = await new Promise((resolve) => new MapConflictModal(this.app, local, disk, resolve).open());
      this.history.clear();
    }
    const before = clone(this.map);
    try {
      change(this.map);
    } catch (error) {
      this.map = before;
      throw error;
    }
    const after = clone(this.map);
    try {
      await this.persist();
    } catch (error) {
      this.map = before;
      this.render();
      throw error;
    }
    const ownership = (map) => JSON.stringify(map.nodes.map((node) => [node.id, node.path, node.parentId]));
    if (ownership(before) !== ownership(after)) await this.plugin.rebuildDerivedData();
    const restore = async (snapshot) => {
      const previous = clone(this.map);
      const next = clone(snapshot);
      if (this.map) next.viewport = clone(this.map.viewport);
      await this.plugin.repo.saveMap(path, next);
      this.map = next;
      if (ownership(previous) !== ownership(next)) await this.plugin.rebuildDerivedData();
      await this.hydrate();
    };
    this.history.push({ undo: () => restore(before), redo: () => restore(after) });
    this.render();
  }
  async restoreLifecycle(snapshot, moves, parked) {
    for (const move of moves) {
      const from = parked ? move.activePath : move.parkedPath, to = parked ? move.parkedPath : move.activePath;
      await this.plugin.repo.moveExact(from, to);
      await this.plugin.repo.setLifecycle(to, move.topicId, parked ? "" : snapshot.id, parked ? move.parkedState : "active");
    }
    await this.plugin.repo.saveMap(this.path, clone(snapshot));
    this.map = clone(snapshot);
    await this.plugin.rebuildDerivedData();
    await this.hydrate();
    this.render();
  }
  async removeToUnassigned(node, branch) {
    if (!this.map) return;
    const before = clone(this.map), ids = branch ? /* @__PURE__ */ new Set([node.id, ...descendants(before.nodes, node.id)]) : /* @__PURE__ */ new Set([node.id]);
    const removed = before.nodes.filter((item) => ids.has(item.id)), moves = [];
    try {
      for (const item of removed) {
        const target = await this.plugin.repo.moveUnique(item.path, this.plugin.repo.topicFolder(this.path, "Unassigned"));
        moves.push({ activePath: item.path, parkedPath: target, topicId: before.id, parkedState: "unassigned" });
        await this.plugin.repo.setLifecycle(target, before.id, "", "unassigned");
      }
      const after = clone(before);
      after.nodes = removeNodes(after.nodes, node.id, branch);
      await this.plugin.repo.saveMap(this.path, after);
      this.map = after;
      this.selected = null;
      this.multiSelected.clear();
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.history.push({ undo: () => this.restoreLifecycle(before, moves, false), redo: () => this.restoreLifecycle(after, moves, true) });
      this.render();
    } catch (error) {
      for (const move of [...moves].reverse()) if (this.app.vault.getAbstractFileByPath(move.parkedPath) && !this.app.vault.getAbstractFileByPath(move.activePath)) await this.plugin.repo.moveExact(move.parkedPath, move.activePath);
      throw error;
    }
  }
  async claimToCurrent(file) {
    if (!this.map) return;
    const before = clone(this.map), previous = await this.plugin.repo.readNote(file.path), original = file.path;
    const target = await this.plugin.repo.moveUnique(original, this.plugin.repo.topicFolder(this.path, "Notes"));
    await this.plugin.repo.setLifecycle(target, this.map.id, this.map.id, "active");
    const node = { id: crypto.randomUUID(), path: target, parentId: null, x: 80, y: Math.max(-100, ...this.map.nodes.map((item) => item.y)) + 240, collapsed: false };
    const after = clone(before);
    after.nodes.push(node);
    await this.plugin.repo.saveMap(this.path, after);
    this.map = after;
    this.selected = node.id;
    await this.plugin.rebuildDerivedData();
    await this.hydrate();
    const undo = async () => {
      await this.plugin.repo.moveExact(target, original);
      await this.plugin.repo.setLifecycle(original, previous.topicId, previous.mapId, previous.topicState);
      await this.plugin.repo.saveMap(this.path, before);
      this.map = clone(before);
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    };
    const redo = async () => {
      await this.plugin.repo.moveExact(original, target);
      await this.plugin.repo.setLifecycle(target, after.id, after.id, "active");
      await this.plugin.repo.saveMap(this.path, after);
      this.map = clone(after);
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    };
    this.history.push({ undo, redo });
    this.render();
    this.focusNode(node);
  }
  async relinkMissingNode(node, file) {
    if (!this.map) return;
    const before = clone(this.map), previous = await this.plugin.repo.readNote(file.path), original = file.path;
    const target = await this.plugin.repo.moveUnique(original, this.plugin.repo.topicFolder(this.path, "Notes"));
    await this.plugin.repo.setLifecycle(target, this.map.id, this.map.id, "active");
    const after = clone(before), replacement = after.nodes.find((item) => item.id === node.id);
    if (!replacement) throw new Error(t("\u627E\u4E0D\u5230\u8981\u91CD\u65B0\u9023\u7D50\u7684\u7BC0\u9EDE\u3002"));
    replacement.path = target;
    await this.plugin.repo.saveMap(this.path, after);
    this.map = after;
    await this.plugin.rebuildDerivedData();
    await this.hydrate();
    const undo = async () => {
      await this.plugin.repo.moveExact(target, original);
      await this.plugin.repo.setLifecycle(original, previous.topicId, previous.mapId, previous.topicState);
      await this.plugin.repo.saveMap(this.path, before);
      this.map = clone(before);
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    };
    const redo = async () => {
      await this.plugin.repo.moveExact(original, target);
      await this.plugin.repo.setLifecycle(target, after.id, after.id, "active");
      await this.plugin.repo.saveMap(this.path, after);
      this.map = clone(after);
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    };
    this.history.push({ undo, redo });
    this.render();
  }
  async parkFile(file, collection, state) {
    if (!this.map) return;
    const before = await this.plugin.repo.readNote(file.path), original = file.path;
    const target = await this.plugin.repo.moveUnique(original, this.plugin.repo.topicFolder(this.path, collection));
    await this.plugin.repo.setLifecycle(target, this.map.id, "", state);
    await this.plugin.rebuildDerivedData();
    const undo = async () => {
      await this.plugin.repo.moveExact(target, original);
      await this.plugin.repo.setLifecycle(original, before.topicId, before.mapId, before.topicState);
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    const redo = async () => {
      await this.plugin.repo.moveExact(original, target);
      await this.plugin.repo.setLifecycle(target, this.map.id, "", state);
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    this.history.push({ undo, redo });
    this.render();
  }
  async transferToTopic(file, topic) {
    const before = await this.plugin.repo.readNote(file.path), original = file.path, folder = `${topic.root}/Unassigned`;
    const target = await this.plugin.repo.moveUnique(original, folder);
    await this.plugin.repo.setLifecycle(target, topic.id, "", "unassigned");
    await this.plugin.rebuildDerivedData();
    const undo = async () => {
      await this.plugin.repo.moveExact(target, original);
      await this.plugin.repo.setLifecycle(original, before.topicId, before.mapId, before.topicState);
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    const redo = async () => {
      await this.plugin.repo.moveExact(original, target);
      await this.plugin.repo.setLifecycle(target, topic.id, "", "unassigned");
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    this.history.push({ undo, redo });
    this.render();
  }
  async transferAndAdd(file, topic) {
    const previous = await this.plugin.repo.readNote(file.path), original = file.path, before = await this.plugin.repo.readMap(topic.mapPath);
    const target = await this.plugin.repo.moveUnique(original, `${topic.root}/Notes`);
    await this.plugin.repo.setLifecycle(target, topic.id, topic.id, "active");
    const node = { id: crypto.randomUUID(), path: target, parentId: null, x: 80, y: Math.max(-100, ...before.nodes.map((item) => item.y)) + 240, collapsed: false };
    const after = clone(before);
    after.nodes.push(node);
    await this.plugin.repo.saveMap(topic.mapPath, after);
    await this.plugin.rebuildDerivedData();
    const undo = async () => {
      await this.plugin.repo.moveExact(target, original);
      await this.plugin.repo.setLifecycle(original, previous.topicId, previous.mapId, previous.topicState);
      await this.plugin.repo.saveMap(topic.mapPath, before);
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    const redo = async () => {
      await this.plugin.repo.moveExact(original, target);
      await this.plugin.repo.setLifecycle(target, topic.id, topic.id, "active");
      await this.plugin.repo.saveMap(topic.mapPath, after);
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    this.history.push({ undo, redo });
    this.render();
  }
  async noteChange(node, patch) {
    const current = await this.plugin.repo.readNote(node.path), before = {};
    for (const key of Object.keys(patch)) before[key] = current[key];
    if (Object.keys(patch).every((key) => current[key] === patch[key])) return;
    await this.plugin.repo.updateNote(node.path, patch);
    this.history.push({ undo: () => this.plugin.repo.updateNote(node.path, before), redo: () => this.plugin.repo.updateNote(node.path, patch) });
    this.notes.set(node.id, await this.plugin.repo.readNote(node.path));
    this.refreshCard(node);
    this.updateHistoryButtons();
  }
  async renameNode(node, title) {
    if (!this.map) return;
    const current = await this.plugin.repo.readNote(node.path), oldTitle = current.title, oldPath = node.path;
    if (oldTitle === title && oldPath.endsWith(`/${title}.md`)) return;
    const apply = async (from, to, nextTitle) => {
      var _a;
      const nextPath = await this.plugin.repo.renameNote(from, nextTitle, to);
      const target = (_a = this.map) == null ? void 0 : _a.nodes.find((item) => item.id === node.id);
      if (target) target.path = nextPath;
      node.path = nextPath;
      if (this.map) await this.plugin.repo.saveMap(this.path, this.map);
      await this.plugin.repo.replaceSourcePath(from, nextPath);
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
      return nextPath;
    };
    const newPath = await apply(oldPath, void 0, title);
    this.history.push({ undo: () => apply(newPath, oldPath, oldTitle).then(() => {
    }), redo: () => apply(oldPath, newPath, title).then(() => {
    }) });
    this.updateHistoryButtons();
  }
  async saveFieldWithConflict(node, key, label, base, value) {
    const latest = await this.plugin.repo.readNote(node.path);
    if (latest[key] !== base && latest[key] !== value) {
      new ConflictModal(this.app, label, value, latest[key], (resolved) => {
        if (resolved === null) this.enqueue(async () => {
          await this.hydrate();
          this.render();
        });
        else this.enqueue(() => key === "title" ? this.renameNode(node, resolved) : this.noteChange(node, { [key]: resolved }));
      }).open();
      return;
    }
    if (key === "title") await this.renameNode(node, value);
    else await this.noteChange(node, { [key]: value });
  }
  openDetails(node) {
    void this.plugin.openDetails(this.plugin.repo.file(node.path)).catch((error) => new import_obsidian4.Notice(error instanceof Error ? error.message : String(error)));
  }
  async travel(redo) {
    const action = redo ? this.history.redo() : this.history.undo();
    if (!action) return;
    try {
      await (redo ? action.redo() : action.undo());
      await this.hydrate();
      this.render();
    } catch (error) {
      if (redo) this.history.undo();
      else this.history.redo();
      throw error;
    }
  }
  updateHistoryButtons() {
    const undo = this.contentEl.querySelector("[data-history=undo]"), redo = this.contentEl.querySelector("[data-history=redo]");
    if (undo) undo.disabled = !this.history.canUndo;
    if (redo) redo.disabled = !this.history.canRedo;
  }
  async synchronize() {
    var _a;
    if (!this.path || !this.map || this.closed) return;
    if (!(this.app.vault.getAbstractFileByPath(this.path) instanceof import_obsidian4.TFile)) {
      this.map = null;
      this.path = "";
      this.history.clear();
      this.render();
      return;
    }
    const disk = await this.plugin.repo.readMap(this.path);
    const structureChanged = JSON.stringify({ ...disk, viewport: null }) !== JSON.stringify({ ...this.map, viewport: null });
    if (structureChanged) {
      disk.viewport = this.map.viewport;
      this.map = disk;
      this.history.clear();
    }
    const before = JSON.stringify(Array.from(this.notes));
    await this.hydrate();
    if (structureChanged || before !== JSON.stringify(Array.from(this.notes))) {
      const editing = this.contentEl.contains(document.activeElement) && ((_a = document.activeElement) == null ? void 0 : _a.matches("input, textarea, select"));
      if ((!editing || structureChanged) && !this.dragging) this.render();
      else for (const node of this.map.nodes) this.refreshCard(node);
    }
  }
  openMapActions() {
    const choices = [];
    if (this.map) {
      choices.push({ label: t("\u91CD\u65B0\u547D\u540D\u76EE\u524D\u5FC3\u667A\u5716"), description: t("\u540C\u6642\u66F4\u65B0\u4E3B\u984C\u8CC7\u6599\u593E\u8207\u5FC3\u667A\u5716\u540D\u7A31\u3002"), action: () => this.renameCurrentMap() });
      if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) choices.push({ label: t("\u6574\u7406\u820A\u8CC7\u6599"), description: t("\u9810\u89BD\u5F8C\u628A\u820A\u7248\u5FC3\u667A\u5716\u6574\u7406\u6210\u76EE\u524D\u7684\u4E3B\u984C\u7D50\u69CB\u3002"), action: () => this.enqueue(() => this.previewMigration()) });
    }
    choices.push({ label: t("\u4FEE\u5FA9\u907A\u5931\u7684\u5FC3\u667A\u5716"), description: t("\u5F9E\u73FE\u6709\u8B70\u984C\u7B46\u8A18\u91CD\u65B0\u5EFA\u7ACB\u7F3A\u5C11\u7684 Map\u3002"), action: () => this.enqueue(() => this.repairMissingTopic()) });
    if (this.map) choices.push({ label: t("\u522A\u9664\u76EE\u524D\u5FC3\u667A\u5716"), description: t("\u53EA\u79FB\u9664\u5FC3\u667A\u5716\u6A94\u6848\uFF0C\u4FDD\u7559\u6240\u6709\u8B70\u984C\u7B46\u8A18\uFF0C\u4E26\u53EF\u7528\u5FA9\u539F\u9084\u539F\u3002"), buttonLabel: t("\u6AA2\u8996"), action: () => this.deleteCurrentMap() });
    new ChoiceModal(this.app, t("\u66F4\u591A\u5FC3\u667A\u5716\u64CD\u4F5C"), t("\u4F4E\u983B\u7684\u7BA1\u7406\u64CD\u4F5C\u96C6\u4E2D\u5728\u9019\u88E1\u3002"), choices).open();
  }
  renameCurrentMap() {
    if (!this.map) return;
    new NameModal(this.app, t("\u91CD\u65B0\u547D\u540D\u5FC3\u667A\u5716"), this.map.title, (title) => this.enqueue(async () => {
      if (!this.map) return;
      if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) {
        new import_obsidian4.Notice(t("\u8ACB\u5148\u6574\u7406\u820A\u8CC7\u6599\uFF0C\u518D\u91CD\u65B0\u547D\u540D\u4E3B\u984C\u3002"));
        return;
      }
      const before = clone(this.map), beforeRoot = this.plugin.repo.topicRoot(this.path);
      this.path = await this.plugin.repo.renameTopic(this.path, title);
      this.map = await this.plugin.repo.readMap(this.path);
      const after = clone(this.map), afterRoot = this.plugin.repo.topicRoot(this.path);
      const restore = async (map, root) => {
        this.path = await this.plugin.repo.renameTopic(this.path, map.title, root);
        this.map = clone(map);
        await this.plugin.repo.saveMap(this.path, this.map);
        await this.plugin.rebuildDerivedData();
        this.render();
      };
      this.history.push({ undo: () => restore(before, beforeRoot), redo: () => restore(after, afterRoot) });
      this.render();
      this.app.workspace.requestSaveLayout();
    })).open();
  }
  deleteCurrentMap() {
    if (!this.map) return;
    new ChoiceModal(this.app, t("\u522A\u9664\u5FC3\u667A\u5716"), t("\u53EA\u5C07\u5FC3\u667A\u5716\u6A94\u6848\u79FB\u5230 Vault \u5783\u573E\u6876\uFF0C\u4FDD\u7559\u6240\u6709\u8B70\u984C\u7B46\u8A18\u3002\u53EF\u4EE5\u4F7F\u7528\u5FA9\u539F\u9084\u539F\u3002"), [
      { label: t("\u522A\u9664\u300C{0}\u300D", this.map.title), description: t("\u8B70\u984C\u7B46\u8A18\u4E0D\u6703\u88AB\u522A\u9664\u3002"), buttonLabel: t("\u79FB\u5230\u5783\u573E\u6876"), action: () => this.enqueue(async () => {
        if (!this.map) return;
        const path = this.path, file = this.plugin.repo.file(path), content = await this.app.vault.read(file), map = clone(this.map);
        await this.app.vault.trash(file, false);
        this.map = null;
        this.path = "";
        await this.plugin.rebuildDerivedData();
        this.history.push({
          undo: async () => {
            await this.app.vault.create(path, content);
            this.path = path;
            this.map = clone(map);
            await this.plugin.rebuildDerivedData();
          },
          redo: async () => {
            await this.app.vault.trash(this.plugin.repo.file(path), false);
            this.path = "";
            this.map = null;
            await this.plugin.rebuildDerivedData();
          }
        });
        this.render();
      }) }
    ]).open();
  }
  async openOrganizer() {
    if (!this.map) return;
    const [unassigned, archived, inbox] = await Promise.all([
      this.plugin.repo.collectionFiles(this.path, "Unassigned"),
      this.plugin.repo.collectionFiles(this.path, "Archive"),
      this.plugin.repo.inboxFiles()
    ]);
    new ChoiceModal(this.app, t("\u6574\u7406\u7B46\u8A18"), t("\u96C6\u4E2D\u8655\u7406\u66AB\u6642\u4E0D\u5728\u5FC3\u667A\u5716\u4E0A\u7684\u5167\u5BB9\u3002"), [
      { label: t("\u672A\u6B78\u985E\uFF08{0}\uFF09", unassigned.length), description: t("\u8A8D\u9818\u5230\u76EE\u524D\u5FC3\u667A\u5716\u3001\u5C01\u5B58\uFF0C\u6216\u79FB\u81F3\u5176\u4ED6\u4E3B\u984C\u3002"), action: () => this.openUnassigned(unassigned) },
      { label: t("\u5C01\u5B58\uFF08{0}\uFF09", archived.length), description: t("\u67E5\u770B\u5DF2\u5C01\u5B58\u7B46\u8A18\uFF0C\u6216\u5C07\u5B83\u5011\u79FB\u56DE\u672A\u6B78\u985E\u3002"), action: () => this.openArchive(archived) },
      { label: t("\u6536\u4EF6\u5323\uFF08{0}\uFF09", inbox.length), description: t("\u5C07\u9084\u6C92\u6709\u4E3B\u984C\u7684\u7B46\u8A18\u79FB\u5165\u9069\u5408\u7684\u4F4D\u7F6E\u3002"), action: () => this.openInbox(inbox) }
    ]).open();
  }
  openUnassigned(files) {
    new NoteCollectionModal(this.app, t("\u672A\u6B78\u985E\u7B46\u8A18"), files, [
      { label: t("\u8A8D\u9818\u5230\u5FC3\u667A\u5716"), run: (file) => this.enqueue(() => this.claimToCurrent(file)) },
      { label: t("\u5C01\u5B58"), run: (file) => this.enqueue(() => this.parkFile(file, "Archive", "archived")) },
      { label: t("\u79FB\u81F3\u5176\u4ED6\u4E3B\u984C"), run: (file) => this.enqueue(async () => {
        const topics = (await this.plugin.repo.topics()).filter((topic) => {
          var _a;
          return topic.id !== ((_a = this.map) == null ? void 0 : _a.id);
        });
        new TopicPickerModal(this.app, t("\u79FB\u81F3\u5176\u4ED6\u4E3B\u984C"), topics, (topic) => this.enqueue(() => this.transferToTopic(file, topic))).open();
      }) },
      { label: t("\u79FB\u52D5\u4E26\u52A0\u5165\u5176\u4ED6\u4E3B\u984C"), run: (file) => this.enqueue(async () => {
        const topics = (await this.plugin.repo.topics()).filter((topic) => {
          var _a;
          return topic.id !== ((_a = this.map) == null ? void 0 : _a.id);
        });
        new TopicPickerModal(this.app, t("\u79FB\u52D5\u4E26\u52A0\u5165\u5176\u4ED6\u5FC3\u667A\u5716"), topics, (topic) => this.enqueue(() => this.transferAndAdd(file, topic))).open();
      }) }
    ]).open();
  }
  openArchive(files) {
    new NoteCollectionModal(this.app, t("\u5C01\u5B58\u7B46\u8A18"), files, [{ label: t("\u53D6\u6D88\u5C01\u5B58"), run: (file) => this.enqueue(() => this.parkFile(file, "Unassigned", "unassigned")) }]).open();
  }
  openInbox(files) {
    new NoteCollectionModal(this.app, t("\u672A\u6307\u5B9A\u4E3B\u984C\u7684\u7B46\u8A18"), files, [
      { label: t("\u79FB\u81F3\u76EE\u524D\u4E3B\u984C"), run: (file) => this.enqueue(() => this.parkFile(file, "Unassigned", "unassigned")) },
      { label: t("\u79FB\u52D5\u4E26\u52A0\u5165\u76EE\u524D\u5FC3\u667A\u5716"), run: (file) => this.enqueue(() => this.claimToCurrent(file)) },
      { label: t("\u9078\u64C7\u5176\u4ED6\u4E3B\u984C"), run: (file) => this.enqueue(async () => {
        const topics = await this.plugin.repo.topics();
        new TopicPickerModal(this.app, t("\u79FB\u81F3\u4E3B\u984C"), topics, (topic) => this.enqueue(() => this.transferToTopic(file, topic))).open();
      }) }
    ]).open();
  }
  render() {
    var _a, _b, _c;
    if (this.closed) return;
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    (_a = this.hoverCard) == null ? void 0 : _a.remove();
    this.hoverCard = null;
    const title = this.getDisplayText();
    if (title !== this.headerTitle) {
      this.headerTitle = title;
      window.setTimeout(() => {
        if (!this.closed) void this.leaf.setViewState({ type: VIEW_TYPE, state: this.getState() });
      }, 0);
    }
    this.contentEl.empty();
    const toolbar = this.contentEl.createDiv("vam-toolbar");
    toolbar.createEl("strong", { text: (_c = (_b = this.map) == null ? void 0 : _b.title) != null ? _c : "Visual Agent Map", cls: "vam-map-title" });
    this.button(toolbar, t("\u5207\u63DB\u5FC3\u667A\u5716"), () => this.enqueue(async () => {
      const topics = await this.plugin.repo.topics();
      new ChoiceModal(this.app, t("\u5207\u63DB\u5FC3\u667A\u5716"), t("\u9078\u64C7\u8981\u958B\u555F\u7684\u7814\u7A76\u4E3B\u984C"), topics.map((topic) => ({ label: topic.title, action: () => this.enqueue(() => this.openMap(topic.mapPath)) }))).open();
    }));
    this.button(toolbar, t("\uFF0B \u5FC3\u667A\u5716"), () => new NameModal(this.app, t("\u65B0\u589E\u5FC3\u667A\u5716"), t("\u65B0\u7684\u5FC3\u667A\u5716"), (title2) => this.enqueue(async () => this.openMap(await this.plugin.repo.createMap(title2)))).open());
    const undo = this.button(toolbar, t("\u5FA9\u539F"), () => this.enqueue(() => this.travel(false)), !this.history.canUndo);
    undo.dataset.history = "undo";
    const redo = this.button(toolbar, t("\u91CD\u505A"), () => this.enqueue(() => this.travel(true)), !this.history.canRedo);
    redo.dataset.history = "redo";
    this.button(toolbar, t("\u66F4\u591A\u2026"), () => this.openMapActions());
    if (!this.map) {
      this.contentEl.createDiv({ cls: "vam-empty", text: t("\u65B0\u589E\u6216\u958B\u555F\u4E00\u5F35\u5FC3\u667A\u5716\uFF0C\u958B\u59CB\u6574\u7406\u4F60\u7684\u8B70\u984C\u3002") });
      return;
    }
    const tools = this.contentEl.createDiv("vam-map-tools");
    this.button(tools, t("\uFF0B \u8B70\u984C"), () => this.enqueue(() => this.addNode(null))).addClass("mod-cta");
    this.button(tools, t("\u6574\u7406"), () => this.enqueue(() => this.openOrganizer()));
    const integrate = this.button(tools, this.integrationMode ? t("\u7D50\u675F\u6574\u5408") : t("\u6574\u5408\u8B70\u984C"), () => {
      this.integrationMode = !this.integrationMode;
      this.multiSelected.clear();
      this.selected = null;
      this.render();
    });
    if (this.integrationMode) integrate.addClass("is-active");
    this.button(tools, "\u2212", () => this.zoomBy(1 / 1.2)).setAttr("aria-label", t("\u7E2E\u5C0F"));
    this.zoomLabel = tools.createSpan({ text: `${Math.round(this.map.viewport.zoom * 100)}%`, cls: "vam-zoom" });
    this.button(tools, "\uFF0B", () => this.zoomBy(1.2)).setAttr("aria-label", t("\u653E\u5927"));
    this.button(tools, t("\u986F\u793A\u5168\u90E8"), () => this.fit());
    const previewControl = tools.createEl("label", { cls: "vam-preview-size" });
    previewControl.createSpan({ text: t("\u9810\u89BD") });
    const previewRange = previewControl.createEl("input", { type: "range", attr: { min: "80", max: "240", step: "5", value: String(clampPreviewScale(this.plugin.settings.previewScale)) } });
    const previewValue = previewControl.createSpan({ cls: "vam-preview-value", text: `${clampPreviewScale(this.plugin.settings.previewScale)}%` });
    let previewSaveTimer = null;
    previewRange.addEventListener("input", () => {
      var _a2;
      const value = clampPreviewScale(previewRange.value);
      this.plugin.settings.previewScale = value;
      previewValue.setText(`${value}%`);
      (_a2 = this.hoverCard) == null ? void 0 : _a2.remove();
      this.hoverCard = null;
      if (previewSaveTimer !== null) window.clearTimeout(previewSaveTimer);
      previewSaveTimer = window.setTimeout(() => {
        void this.plugin.saveSettings();
        previewSaveTimer = null;
      }, 250);
    });
    tools.createSpan({ cls: "vam-hint", text: t("\u62D6\u66F3\u7A7A\u767D\u8655\u5E73\u79FB \xB7 \u6EFE\u8F2A\u7E2E\u653E \xB7 \u9EDE\u9078\u7BC0\u9EDE\u7DE8\u8F2F") });
    const workspace = this.contentEl.createDiv("vam-workspace");
    this.viewportEl = workspace.createDiv("vam-viewport");
    this.stageEl = this.viewportEl.createDiv("vam-stage");
    this.edgesEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.edgesEl.addClass("vam-edges");
    this.stageEl.appendChild(this.edgesEl);
    const shown = visibleNodes(this.map.nodes);
    if (this.selected && !shown.some((node) => node.id === this.selected)) this.selected = null;
    this.multiSelected = new Set([...this.multiSelected].filter((id) => shown.some((node) => node.id === id)));
    if (this.integrationMode) {
      const selection = workspace.createDiv("vam-selection-bar");
      const names = [...this.multiSelected].map((id) => {
        var _a2;
        return (_a2 = this.notes.get(id)) == null ? void 0 : _a2.title;
      }).filter(Boolean);
      selection.createSpan({ text: this.multiSelected.size ? t("\u5DF2\u9078 {0} \u500B\uFF1A{1}{2}", this.multiSelected.size, names.slice(0, 2).join("\u3001"), names.length > 2 ? "\u2026" : "") : t("\u8ACB\u9EDE\u9078\u81F3\u5C11 2 \u500B\u8B70\u984C") });
      this.button(selection, t("\u6E05\u9664"), () => {
        this.multiSelected.clear();
        this.render();
      }, !this.multiSelected.size);
      this.button(selection, t("\u4E0B\u4E00\u6B65"), () => this.integrateSelected(), this.multiSelected.size < 2).addClass("mod-cta");
    }
    for (const node of shown) this.renderNode(node);
    if (!this.map.nodes.length) this.viewportEl.createDiv({ cls: "vam-empty", text: t("\u9019\u5F35\u5FC3\u667A\u5716\u9084\u6C92\u6709\u8B70\u984C\u3002\u9EDE\u300C\uFF0B \u8B70\u984C\u300D\u5EFA\u7ACB\u7B2C\u4E00\u500B\u7BC0\u9EDE\u3002") });
    this.setupPan();
    this.transform();
    this.drawEdges();
    if (this.selected) {
      const node = this.map.nodes.find((n) => n.id === this.selected);
      if (node) this.renderInspector(workspace, node);
    }
  }
  renderNode(node) {
    var _a, _b, _c, _d, _e;
    if (!this.stageEl) return;
    const note = this.notes.get(node.id), card = this.stageEl.createDiv({ cls: `vam-node${node.id === this.selected || this.multiSelected.has(node.id) ? " is-selected" : ""}` });
    card.dataset.nodeId = node.id;
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    card.tabIndex = 0;
    card.setAttr("aria-label", (_a = note == null ? void 0 : note.title) != null ? _a : t("\u7B46\u8A18\u4E0D\u5B58\u5728"));
    const header = card.createDiv("vam-node-header");
    if (this.integrationMode) {
      const check = header.createSpan({ cls: `vam-select-check${this.multiSelected.has(node.id) ? " is-checked" : ""}`, text: this.multiSelected.has(node.id) ? "\u2713" : "" });
      check.setAttr("aria-hidden", "true");
    }
    if (!note || note.status !== "completed") header.createSpan({ cls: `vam-status vam-status-${(_b = note == null ? void 0 : note.status) != null ? _b : "error"}`, text: note ? t(labels[note.status]) : t("\u7B46\u8A18\u4E0D\u5B58\u5728") });
    if (this.plugin.pendingSuggestions.has(node.path)) header.createSpan({ cls: "vam-badge-new", text: t("\u5F85\u78BA\u8A8D\u5EFA\u8B70") });
    const details = this.button(header, "\u2197", () => this.openDetails(node));
    details.addClass("vam-detail-button");
    details.setAttr("aria-label", t("\u5728\u53F3\u5074\u6B04\u958B\u555F\u8A73\u60C5"));
    const count = descendants(this.map.nodes, node.id).size;
    if (count) this.button(header, node.collapsed ? t("\u5C55\u958B {0}", count) : t("\u6536\u5408"), () => this.enqueue(() => this.mapChange((map) => {
      const n = map.nodes.find((n2) => n2.id === node.id);
      n.collapsed = !n.collapsed;
    })));
    const title = card.createEl("h3", { text: (_c = note == null ? void 0 : note.title) != null ? _c : node.path, cls: "vam-card-title" });
    title.setAttr("title", (_d = note == null ? void 0 : note.title) != null ? _d : node.path);
    card.createEl("p", { cls: "vam-card-summary", text: (_e = note == null ? void 0 : note.summary) != null ? _e : t("\u6A94\u6848\u5DF2\u79FB\u52D5\u6216\u522A\u9664\uFF0C\u53EF\u5F9E\u5716\u4E2D\u79FB\u9664\u6B64\u7BC0\u9EDE\u3002") });
    this.enableDrag(card, node);
    card.addEventListener("click", (event) => {
      if (Date.now() < this.suppressClickUntil) return;
      if (event.target.closest("button") || event.metaKey || event.ctrlKey) return;
      if (this.integrationMode) {
        if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id);
        else this.multiSelected.add(node.id);
        this.render();
        return;
      }
      this.multiSelected.clear();
      this.selected = node.id;
      this.render();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target === card) {
        this.selected = node.id;
        this.render();
      }
    });
    card.addEventListener("contextmenu", (event) => {
      var _a2;
      event.preventDefault();
      new ChoiceModal(this.app, (_a2 = note == null ? void 0 : note.title) != null ? _a2 : t("\u8B70\u984C\u64CD\u4F5C"), t("\u9078\u64C7\u64CD\u4F5C"), [
        { label: t("\u65B0\u589E\u5B50\u8B70\u984C"), action: () => this.enqueue(() => this.addNode(node)) },
        { label: t("AI \u62C6\u89E3\u8B70\u984C"), action: () => this.enqueue(() => this.proposeChildren(node)) },
        { label: node.collapsed ? t("\u5C55\u958B\u5206\u652F") : t("\u6536\u5408\u5206\u652F"), action: () => this.enqueue(() => this.mapChange((map) => {
          map.nodes.find((n) => n.id === node.id).collapsed = !node.collapsed;
        })) },
        { label: t("\u5728\u53F3\u5074\u6B04\u958B\u555F\u8A73\u60C5"), action: () => this.openDetails(node) },
        { label: t("\u91CD\u65B0\u8B80\u53D6\u7B46\u8A18"), action: () => this.enqueue(async () => {
          await this.hydrate();
          this.render();
        }) },
        { label: t("\u5F9E\u5716\u4E2D\u79FB\u9664"), action: () => this.enqueue(() => this.removeToUnassigned(node, false)) }
      ]).open();
    });
    card.addEventListener("mouseenter", () => {
      if (!note || this.integrationMode || this.dragging) return;
      this.clearHoverTimer();
      this.hoverTimer = window.setTimeout(() => {
        if (!this.dragging && card.isConnected) this.showHoverCard(card, note);
      }, 700);
    });
    card.addEventListener("mouseleave", () => this.hideHoverCardSoon());
  }
  clearHoverTimer() {
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
  }
  hideHoverCardSoon() {
    this.clearHoverTimer();
    this.hoverTimer = window.setTimeout(() => {
      var _a;
      (_a = this.hoverCard) == null ? void 0 : _a.remove();
      this.hoverCard = null;
      this.hoverTimer = null;
    }, 220);
  }
  showHoverCard(card, note) {
    var _a, _b, _c, _d;
    const workspace = this.contentEl.querySelector(".vam-workspace");
    if (!workspace) return;
    (_a = this.hoverCard) == null ? void 0 : _a.remove();
    const preview = workspace.createDiv("vam-hover-card");
    this.hoverCard = preview;
    const size = previewMetrics(this.plugin.settings.previewScale);
    preview.style.maxHeight = `${size.height}px`;
    preview.style.setProperty("--vam-hover-image-max", size.image);
    preview.style.setProperty("--vam-hover-title-size", size.title);
    preview.style.setProperty("--vam-hover-body-size", size.body);
    preview.style.setProperty("--vam-hover-label-size", size.labelSize);
    preview.style.setProperty("--vam-hover-table-size", size.table);
    preview.style.setProperty("--vam-hover-line-height", size.line);
    preview.style.setProperty("--vam-hover-padding", size.padding);
    preview.addEventListener("mouseenter", () => this.clearHoverTimer());
    preview.addEventListener("mouseleave", () => this.hideHoverCardSoon());
    preview.createEl("strong", { text: note.title });
    const content = preview.createDiv("vam-hover-markdown");
    const path = (_d = (_c = (_b = this.map) == null ? void 0 : _b.nodes.find((node) => node.id === card.dataset.nodeId)) == null ? void 0 : _c.path) != null ? _d : "";
    void import_obsidian4.MarkdownRenderer.render(this.app, note.preview || t("\u5C1A\u672A\u52A0\u5165\u9810\u89BD\u5167\u5BB9"), content, path, this);
    const host = workspace.getBoundingClientRect(), rect = card.getBoundingClientRect();
    const availableWidth = Math.max(180, host.width - 24);
    const width = Math.min(size.max, Math.max(Math.min(size.min, availableWidth), availableWidth));
    preview.style.width = `${width}px`;
    let left = rect.right - host.left + 12;
    if (left + width > host.width - 12) left = rect.left - host.left - width - 12;
    const visibleHeight = Math.min(size.height, Math.max(180, host.height - 24));
    const maxTop = Math.max(12, host.height - visibleHeight - 12);
    preview.style.left = `${Math.max(12, Math.min(left, Math.max(12, host.width - width - 12)))}px`;
    preview.style.top = `${Math.max(12, Math.min(rect.top - host.top, maxTop))}px`;
  }
  refreshCard(node) {
    var _a, _b, _c, _d;
    const card = (_a = this.stageEl) == null ? void 0 : _a.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`), note = this.notes.get(node.id);
    if (!card || !note) return;
    card.setAttr("aria-label", note.title);
    (_b = card.querySelector(".vam-card-title")) == null ? void 0 : _b.setAttr("title", note.title);
    (_c = card.querySelector(".vam-card-title")) == null ? void 0 : _c.setText(note.title);
    (_d = card.querySelector(".vam-card-summary")) == null ? void 0 : _d.setText(note.summary);
    const header = card.querySelector(".vam-node-header");
    const status = card.querySelector(".vam-status");
    if (note.status === "completed") status == null ? void 0 : status.remove();
    else if (status) {
      status.className = `vam-status vam-status-${note.status}`;
      status.setText(labels[note.status]);
    } else header == null ? void 0 : header.createSpan({ cls: `vam-status vam-status-${note.status}`, text: labels[note.status] });
    this.drawEdges();
  }
  renderInspector(parent, node) {
    var _a, _b, _c, _d, _e, _f;
    const panel = parent.createDiv("vam-inspector"), note = this.notes.get(node.id);
    const heading = panel.createDiv("vam-inspector-heading");
    heading.createEl("strong", { text: t("\u8B70\u984C\u5DE5\u4F5C\u53F0") });
    this.button(heading, t("\u95DC\u9589"), () => {
      this.selected = null;
      this.render();
    });
    if (note) {
      const field = (label, key, rows = 0) => {
        const wrapper = panel.createEl("label", { cls: "vam-field" });
        wrapper.createSpan({ text: label });
        const input = rows ? wrapper.createEl("textarea", { text: note[key] }) : wrapper.createEl("input", { type: "text", value: note[key] });
        input.setAttr("aria-label", label);
        if (input instanceof HTMLTextAreaElement) input.rows = rows;
        const base = note[key];
        input.addEventListener("change", () => {
          const value = key === "title" ? input.value.trim() || t("\u672A\u547D\u540D\u8B70\u984C") : input.value.trim();
          note[key] = value;
          this.enqueue(() => this.saveFieldWithConflict(node, key, label, base, value));
        });
      };
      field(t("\u8B70\u984C"), "title");
      field(t("\u76EE\u524D\u7406\u89E3"), "summary", 4);
      field(t("\u9810\u89BD"), "preview", 6);
      field(t("AI \u898F\u5247"), "rules", 4);
      const sourcePaths = this.referenceSourcePaths(note, node.path);
      if (sourcePaths.length) {
        const sources = panel.createDiv("vam-reference-sources");
        sources.createEl("strong", { text: t("\u4F86\u6E90\u8B70\u984C") });
        for (const path of sourcePaths) {
          const sourceNode = (_a = this.map) == null ? void 0 : _a.nodes.find((item) => item.path === path), sourceNote = sourceNode ? this.notes.get(sourceNode.id) : null;
          const file = this.app.vault.getAbstractFileByPath(path);
          this.button(sources, (_c = sourceNote == null ? void 0 : sourceNote.title) != null ? _c : file instanceof import_obsidian4.TFile ? file.basename : t("{0}\uFF08\u5DF2\u79FB\u52D5\uFF09", (_b = path.split("/").at(-1)) == null ? void 0 : _b.replace(/\.md$/, "")), () => {
            if (sourceNode) {
              this.selected = sourceNode.id;
              this.render();
              this.focusNode(sourceNode);
            } else if (file instanceof import_obsidian4.TFile) void this.plugin.openDetails(file);
          }, !(sourceNode || file instanceof import_obsidian4.TFile));
        }
      }
      const actions = panel.createDiv("vam-actions");
      const running = this.plugin.running.has(node.path);
      const previewTask = (title, prompt) => this.enqueue(async () => {
        const latest = await this.plugin.repo.readNote(node.path);
        new TaskModal(
          this.app,
          prompt,
          (value, run) => this.enqueue(async () => {
            await this.noteChange(node, { prompt: value });
            if (run) await this.runAgent(node);
          }),
          title,
          t("AI \u5B8C\u6210\u5F8C\u6703\u76F4\u63A5\u66F4\u65B0\u76EE\u524D\u7406\u89E3\uFF0C\u5B8C\u6574\u7D50\u679C\u6703\u4FDD\u5B58\u5728 MD \u8A73\u60C5\u4E2D\u3002\u9001\u51FA\u524D\u53EF\u8ABF\u6574\u4EFB\u52D9\u3002"),
          latest.rules
        ).open();
      });
      const nextSteps = [
        { label: t("\u7814\u7A76\u9019\u500B\u8B70\u984C"), description: t("\u88DC\u8DB3\u8CC7\u8A0A\u3001\u4F86\u6E90\u8207\u4ECD\u5F85\u78BA\u8A8D\u4E4B\u8655\u3002"), action: () => previewTask(t("\u78BA\u8A8D\u7814\u7A76\u4EFB\u52D9"), `\u7814\u7A76\u300C${note.title}\u300D\uFF0C\u88DC\u8DB3\u8CC7\u8A0A\u3001\u4F86\u6E90\u8207\u4E0D\u78BA\u5B9A\u8655\u3002`) },
        { label: t("\u6BD4\u8F03\u53EF\u884C\u9078\u9805"), description: t("\u6574\u7406\u65B9\u6848\u3001\u53D6\u6368\u8207\u5EFA\u8B70\u3002"), action: () => previewTask(t("\u78BA\u8A8D\u6BD4\u8F03\u4EFB\u52D9"), `\u6BD4\u8F03\u300C${note.title}\u300D\u7684\u53EF\u884C\u9078\u9805\u3001\u53D6\u6368\u8207\u5EFA\u8B70\u3002`) },
        { label: t("\u6AA2\u67E5\u98A8\u96AA\u8207\u5047\u8A2D"), description: t("\u5C0B\u627E\u53CD\u4F8B\u3001\u98A8\u96AA\u53CA\u5F85\u9A57\u8B49\u5047\u8A2D\u3002"), action: () => previewTask(t("\u78BA\u8A8D\u98A8\u96AA\u6AA2\u67E5\u4EFB\u52D9"), `\u627E\u51FA\u300C${note.title}\u300D\u7684\u53CD\u4F8B\u3001\u98A8\u96AA\u8207\u5F85\u9A57\u8B49\u5047\u8A2D\u3002`) },
        { label: t("\u7531 AI \u62C6\u6210\u5B50\u8B70\u984C"), description: t("\u7522\u751F 3\u20137 \u500B\u5EFA\u8B70\uFF1B\u78BA\u8A8D\u5F8C\u624D\u5EFA\u7ACB\u7BC0\u9EDE\u3002"), action: () => this.enqueue(() => this.proposeChildren(node)) },
        { label: t("\u6574\u5408\u5B50\u8B70\u984C\u767C\u73FE"), description: t("\u5F59\u6574\u76F4\u5C6C\u5B50\u8B70\u984C\uFF1B\u78BA\u8A8D\u4EFB\u52D9\u5F8C\u81EA\u52D5\u66F4\u65B0\u76EE\u524D\u7406\u89E3\u3002"), action: () => this.enqueue(() => this.integrateChildren(node)) },
        { label: t("\u624B\u52D5\u65B0\u589E\u5B50\u8B70\u984C"), description: t("\u5EFA\u7ACB\u7A7A\u767D\u5B50\u8B70\u984C\uFF0C\u4E0D\u6703\u57F7\u884C AI\u3002"), action: () => this.enqueue(() => this.addNode(node)) },
        { label: t("\u81EA\u5DF1\u63CF\u8FF0\u4E0B\u4E00\u6B65"), description: t("\u81EA\u884C\u64B0\u5BEB\u9019\u6B21\u8981 AI \u5B8C\u6210\u7684\u5DE5\u4F5C\uFF0C\u53EF\u53EA\u5132\u5B58\u6216\u78BA\u8A8D\u4E26\u57F7\u884C\u3002"), action: () => previewTask(t("\u81EA\u5DF1\u63CF\u8FF0\u4E0B\u4E00\u6B65"), note.prompt) }
      ];
      if (note.prompt.trim()) nextSteps.splice(3, 0, { label: t("\u57F7\u884C\u5DF2\u4FDD\u5B58\u7684\u4EFB\u52D9"), description: t("\u57F7\u884C\u5148\u524D\u4FDD\u5B58\u7684\u4EFB\u52D9\uFF1B\u9001\u51FA\u524D\u4ECD\u53EF\u4FEE\u6539\u3002"), action: () => previewTask(t("\u78BA\u8A8D\u5DF2\u4FDD\u5B58\u7684\u4EFB\u52D9"), note.prompt) });
      this.button(actions, running ? t("AI \u57F7\u884C\u4E2D\u2026") : t("\u9078\u64C7\u4E0B\u4E00\u6B65"), () => this.enqueue(async () => {
        var _a2;
        const input = panel.querySelector(`textarea[aria-label="${t("AI \u898F\u5247")}"]`);
        const rules = (_a2 = input == null ? void 0 : input.value.trim()) != null ? _a2 : note.rules;
        const latest = await this.plugin.repo.readNote(node.path);
        if (rules !== latest.rules) await this.noteChange(node, { rules });
        new ChoiceModal(this.app, t("\u4E0B\u4E00\u6B65"), t("\u9078\u64C7\u76EE\u7684\u5F8C\uFF0C\u518D\u78BA\u8A8D AI \u5C07\u57F7\u884C\u7684\u4EFB\u52D9\u3002"), nextSteps).open();
      }), running).addClass("mod-cta");
      const pending = this.plugin.pendingSuggestions.get(node.path);
      if (pending == null ? void 0 : pending.length) this.button(actions, t("\u67E5\u770B AI \u5B50\u8B70\u984C\u5EFA\u8B70\uFF08{0}\uFF09", pending.length), () => this.openChildSuggestions(node, pending), running);
      const advanced = panel.createEl("details", { cls: "vam-advanced" });
      advanced.createEl("summary", { text: t("\u6A21\u578B\u8207\u9032\u968E\u8A2D\u5B9A") });
      const modelLabel = advanced.createEl("label", { cls: "vam-field" });
      modelLabel.createSpan({ text: t("\u4F7F\u7528\u6A21\u578B") });
      const select = modelLabel.createEl("select");
      select.setAttr("aria-label", t("\u4F7F\u7528\u6A21\u578B"));
      const options = new Set([this.plugin.settings.cliModel, ...this.plugin.settings.models.split(/[\n,]/), ...Array.from(this.notes.values()).map((n) => n.model)].map((s) => s.trim()).filter(Boolean));
      for (const model of options) select.createEl("option", { value: model, text: model });
      select.createEl("option", { value: "__custom__", text: t("\u81EA\u8A02\u6A21\u578B\u2026") });
      select.value = note.model;
      const custom = modelLabel.createEl("input", { type: "text", placeholder: t("\u8F38\u5165\u6A21\u578B ID") });
      custom.setAttr("aria-label", t("\u81EA\u8A02\u6A21\u578B ID"));
      custom.hidden = true;
      select.addEventListener("change", () => {
        custom.hidden = select.value !== "__custom__";
        if (!custom.hidden) custom.focus();
        else this.enqueue(() => this.noteChange(node, { model: select.value, modelSource: "manual" }));
      });
      custom.addEventListener("change", () => {
        const model = custom.value.trim();
        if (!model) return;
        this.enqueue(async () => {
          await this.noteChange(node, { model, modelSource: "manual" });
          if (!Array.from(select.options).some((option) => option.value === model)) select.add(new Option(model, model), select.options.length - 1);
          select.value = model;
          custom.hidden = true;
        });
      });
      const sourceLabels = { workspace: t("\u5DE5\u4F5C\u5340\u9810\u8A2D"), inherited: t("\u5EFA\u7ACB\u6642\u7E7C\u627F"), manual: t("\u624B\u52D5\u6307\u5B9A") };
      advanced.createEl("p", { cls: "vam-hint", text: t("{0} \xB7 {1}\uFF1B\u4E00\u822C\u4EFB\u52D9\u4F7F\u7528\u4F4E\u63A8\u7406\uFF0C\u6574\u5408\u5B50\u8B70\u984C\u4F7F\u7528\u9AD8\u63A8\u7406\u3002", note.model, sourceLabels[note.modelSource]) });
    } else {
      panel.createEl("p", { text: t("\u6B64\u7BC0\u9EDE\u7684\u7B46\u8A18\u4E0D\u5B58\u5728\uFF0C\u53EF\u91CD\u65B0\u9023\u7D50\u672A\u6B78\u985E\u7B46\u8A18\u6216\u5F9E\u5716\u4E2D\u79FB\u9664\u3002") });
      this.button(panel, t("\u91CD\u65B0\u9023\u7D50\u7B46\u8A18"), () => this.enqueue(async () => {
        const candidates = [...await this.plugin.repo.collectionFiles(this.path, "Unassigned"), ...await this.plugin.repo.inboxFiles()];
        new NoteCollectionModal(this.app, t("\u91CD\u65B0\u9023\u7D50\u7B46\u8A18"), candidates, [{ label: t("\u4F7F\u7528\u9019\u4EFD\u7B46\u8A18"), run: (file) => this.enqueue(() => this.relinkMissingNode(node, file)) }]).open();
      }));
    }
    this.button(panel, t("\u5F9E\u5716\u4E2D\u79FB\u9664"), () => new ChoiceModal(this.app, t("\u5F9E\u5716\u4E2D\u79FB\u9664"), t("\u7B46\u8A18\u6703\u79FB\u81F3\u76EE\u524D\u4E3B\u984C\u7684 Unassigned\uFF0C\u53EF\u91CD\u65B0\u8A8D\u9818\u6216\u5FA9\u539F\u3002"), [{ label: t("\u53EA\u79FB\u9664\u6B64\u7BC0\u9EDE\uFF0C\u5B50\u8B70\u984C\u8B8A\u6210\u6839\u8B70\u984C"), action: () => this.enqueue(() => this.removeToUnassigned(node, false)) }]).open());
    const relationship = panel.createEl("details", { cls: "vam-advanced" });
    relationship.createEl("summary", { text: t("\u7D50\u69CB\u8207\u9023\u7D50") });
    const parentLabel = relationship.createEl("label", { cls: "vam-field" });
    parentLabel.createSpan({ text: t("\u6240\u5C6C\u6BCD\u8B70\u984C") });
    const parents = parentLabel.createEl("select");
    parents.setAttr("aria-label", t("\u6BCD\u8B70\u984C\uFF0F\u9023\u7D50"));
    parents.createEl("option", { value: "", text: t("\u7121\u6BCD\u8B70\u984C\uFF08\u6839\u8B70\u984C\uFF09") });
    for (const candidate of this.map.nodes) if (canParent(this.map.nodes, node.id, candidate.id)) parents.createEl("option", { value: candidate.id, text: (_e = (_d = this.notes.get(candidate.id)) == null ? void 0 : _d.title) != null ? _e : candidate.path });
    parents.value = (_f = node.parentId) != null ? _f : "";
    parents.addEventListener("change", () => {
      const parentId = parents.value || null;
      this.enqueue(() => this.mapChange((map) => {
        if (!canParent(map.nodes, node.id, parentId)) throw new Error(t("\u4E0D\u80FD\u5EFA\u7ACB\u5FAA\u74B0\u9023\u7D50\u3002"));
        map.nodes.find((n) => n.id === node.id).parentId = parentId;
      }));
    });
    this.button(relationship, t("\u79FB\u9664\u6BCD\u8B70\u984C\u9023\u7D50"), () => this.enqueue(() => this.mapChange((map) => {
      map.nodes.find((n) => n.id === node.id).parentId = null;
    })), !node.parentId);
    relationship.createEl("p", { cls: "vam-hint", text: t("\u66F4\u63DB\u6BCD\u8B70\u984C\u6703\u5F71\u97FF\u4E0B\u6B21 AI \u4EFB\u52D9\u53D6\u5F97\u7684\u80CC\u666F\uFF0C\u4E0D\u6703\u66F4\u52D5\u6A21\u578B\u3002") });
    this.button(relationship, t("\u5F9E\u5716\u4E2D\u79FB\u9664"), () => new ChoiceModal(this.app, t("\u5F9E\u5716\u4E2D\u79FB\u9664"), t("\u7B46\u8A18\u6703\u79FB\u81F3\u76EE\u524D\u4E3B\u984C\u7684 Unassigned\uFF0C\u53EF\u91CD\u65B0\u8A8D\u9818\u6216\u5FA9\u539F\u3002"), [{ label: t("\u53EA\u79FB\u9664\u6B64\u7BC0\u9EDE\uFF0C\u5B50\u8B70\u984C\u8B8A\u6210\u6839\u8B70\u984C"), action: () => this.enqueue(() => this.removeToUnassigned(node, false)) }, { label: t("\u79FB\u9664\u6574\u500B\u5206\u652F"), action: () => this.enqueue(() => this.removeToUnassigned(node, true)) }]).open());
  }
  async previewMigration() {
    const plan = await this.plugin.repo.legacyMigrationPlan();
    if (!plan.maps.length && !plan.orphanPaths.length) {
      new import_obsidian4.Notice(t("\u6C92\u6709\u9700\u8981\u6574\u7406\u7684\u820A\u8CC7\u6599\u3002"));
      return;
    }
    const noteCount = plan.maps.reduce((sum, item) => sum + item.notePaths.length, 0);
    const description = t("\u5C07\u5EFA\u7ACB {0} \u500B\u4E3B\u984C\u8CC7\u6599\u593E\uFF0C\u642C\u79FB {1} \u4EFD\u5716\u5167\u7B46\u8A18\uFF0C\u4E26\u5C07 {2} \u4EFD\u5B64\u5152\u7B46\u8A18\u79FB\u81F3 Inbox\u3002\u4EFB\u4E00\u6B65\u5931\u6557\u90FD\u6703\u9084\u539F\u5DF2\u642C\u79FB\u7684\u6A94\u6848\u3002", plan.maps.length, noteCount, plan.orphanPaths.length);
    new ChoiceModal(this.app, t("\u6574\u7406\u820A\u7248\u8CC7\u6599"), description, [{ label: t("\u78BA\u8A8D\u6574\u7406"), action: () => this.enqueue(async () => {
      const current = this.path, mapping = await this.plugin.repo.migrateLegacyWorkspace(plan), next = mapping.get(current);
      this.history.clear();
      if (next) await this.openMap(next);
      else this.render();
      new import_obsidian4.Notice(t("\u820A\u8CC7\u6599\u5DF2\u6574\u7406\u70BA\u4E3B\u984C\u8CC7\u6599\u593E\u3002"));
    }) }]).open();
  }
  async repairMissingTopic() {
    const broken = await this.plugin.repo.brokenTopics();
    if (!broken.length) {
      new import_obsidian4.Notice(t("\u6C92\u6709\u7F3A\u5C11 Map.md \u7684\u4E3B\u984C\u3002"));
      return;
    }
    new ChoiceModal(this.app, t("\u4FEE\u5FA9\u907A\u5931 Map"), t("\u9078\u64C7\u8981\u4FEE\u5FA9\u7684\u4E3B\u984C"), broken.map((topic) => ({ label: t("{0}\uFF08{1} \u4EFD Notes\uFF09", topic.title, topic.noteCount), action: () => {
      new ChoiceModal(this.app, topic.title, t("\u53EF\u7531 Notes \u91CD\u5EFA\u6240\u6709\u7BC0\u9EDE\u7686\u70BA\u6839\u7BC0\u9EDE\u7684\u65B0 Map\uFF0C\u6216\u91CD\u65B0\u9023\u7D50\u4F4D\u65BC\u4E3B\u984C\u8CC7\u6599\u593E\u5916\u7684\u65E2\u6709 Map\u3002"), [
        { label: t("\u5F9E Notes \u91CD\u5EFA"), action: () => this.enqueue(async () => this.openMap(await this.plugin.repo.rebuildMissingMap(topic.root))) },
        { label: t("\u91CD\u65B0\u9023\u7D50\u65E2\u6709 Map"), action: () => this.enqueue(async () => {
          const candidates = (await this.plugin.repo.mapFiles()).filter((file) => !file.path.startsWith(`${this.plugin.settings.topicsFolder}/`));
          new ChoiceModal(this.app, t("\u9078\u64C7\u65E2\u6709 Map"), t("\u9078\u53D6\u5F8C\u6703\u642C\u56DE\u6B64\u4E3B\u984C\u4E26\u91CD\u65B0\u5EFA\u7ACB\u53EF\u8FA8\u8B58\u7684\u7BC0\u9EDE\u8DEF\u5F91\u3002"), candidates.map((file) => ({ label: file.path, action: () => this.enqueue(async () => this.openMap(await this.plugin.repo.relinkMissingMap(topic.root, file.path))) }))).open();
        }) }
      ]).open();
    } }))).open();
  }
  async addNode(parent, suggestedTitle) {
    var _a, _b;
    if (!this.map) return;
    const model = inheritModel(parent ? (await this.plugin.repo.readNote(parent.path)).model : void 0, this.plugin.settings.cliModel);
    if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) {
      new import_obsidian4.Notice(t("\u8ACB\u5148\u4F7F\u7528\u300C\u6574\u7406\u820A\u8CC7\u6599\u300D\u8F49\u63DB\u76EE\u524D\u5FC3\u667A\u5716\u3002"));
      return;
    }
    const node = await this.plugin.repo.createNote((suggestedTitle == null ? void 0 : suggestedTitle.trim()) || (parent ? t("\u65B0\u7684\u5B50\u8B70\u984C") : t("\u6211\u7684\u6838\u5FC3\u8B70\u984C")), model, this.map, this.path, parent ? "inherited" : "workspace");
    if (parent) await this.plugin.repo.updateNote(node.path, { rules: (await this.plugin.repo.readNote(parent.path)).rules });
    node.parentId = (_a = parent == null ? void 0 : parent.id) != null ? _a : null;
    node.x = parent ? parent.x + 340 : 80;
    const siblings = this.map.nodes.filter((n) => n.parentId === node.parentId);
    node.y = siblings.length ? Math.max(...siblings.map((n) => n.y)) + 220 : (_b = parent == null ? void 0 : parent.y) != null ? _b : 80;
    this.notes.set(node.id, await this.plugin.repo.readNote(node.path));
    this.selected = node.id;
    await this.mapChange((map) => {
      map.nodes.push(node);
      if (parent) map.nodes.find((n) => n.id === parent.id).collapsed = false;
    });
    this.focusNode(node);
  }
  async proposeChildren(parent, confirmed = false) {
    const pending = this.plugin.pendingSuggestions.get(parent.path);
    if (pending == null ? void 0 : pending.length) {
      this.openChildSuggestions(parent, pending);
      return;
    }
    const note = await this.plugin.repo.readNote(parent.path);
    if (this.plugin.running.has(parent.path)) return;
    if (!confirmed) {
      new ChoiceModal(this.app, t("\u78BA\u8A8D AI \u62C6\u89E3"), t("AI \u6703\u5206\u6790\u76EE\u524D\u8B70\u984C\u4E26\u63D0\u51FA 3\u20137 \u500B\u5B50\u8B70\u984C\uFF1B\u7D50\u679C\u5B8C\u6210\u5F8C\u4ECD\u9700\u7531\u4F60\u78BA\u8A8D\u624D\u6703\u5EFA\u7ACB\u7BC0\u9EDE\u3002\n\n\u672C\u6B21\u5957\u7528\u7684 AI \u898F\u5247\uFF1A\n{0}", note.rules.trim() || "\u672A\u8A2D\u5B9A\u984D\u5916\u898F\u5247\u3002"), [
        { label: t("\u4F7F\u7528 {0}", note.model), description: t("\u9019\u6703\u57F7\u884C\u4E00\u6B21\u4F4E\u63A8\u7406 AI \u4EFB\u52D9\uFF0C\u4E0D\u6703\u76F4\u63A5\u4FEE\u6539\u5FC3\u667A\u5716\u7D50\u69CB\u3002"), buttonLabel: t("\u78BA\u8A8D\u4E26\u57F7\u884C"), action: () => this.enqueue(() => this.proposeChildren(parent, true)) }
      ]).open();
      return;
    }
    this.plugin.running.add(parent.path);
    this.render();
    try {
      const result = await this.plugin.askModel({ title: note.title, summary: note.summary, rules: note.rules, detail: note.detail, task: "\u8ACB\u5224\u65B7\u6B64\u8B70\u984C\u662F\u5426\u9700\u8981\u62C6\u89E3\u3002\u82E5\u9700\u8981\uFF0C\u63D0\u51FA 3 \u5230 7 \u500B\u53EF\u7368\u7ACB\u8655\u7406\u7684\u5B50\u8B70\u984C\uFF0C\u6BCF\u9805\u63D0\u4F9B title\u3001task \u8207 contribution\uFF1B\u4E0D\u8981\u5EFA\u7ACB\u6216\u4FEE\u6539\u4EFB\u4F55\u6A94\u6848\u3002", ancestors: await this.ancestorContext(parent), mode: "decompose" }, note.model);
      const suggestions = result.suggestions.slice(0, 7);
      if (!suggestions.length) {
        new import_obsidian4.Notice(t("AI \u8A8D\u70BA\u76EE\u524D\u4E0D\u9700\u8981\u62C6\u89E3\uFF0C\u6216\u6C92\u6709\u63D0\u51FA\u53EF\u5EFA\u7ACB\u7684\u5B50\u8B70\u984C\u3002"));
        return;
      }
      this.plugin.pendingSuggestions.set(parent.path, suggestions);
      new import_obsidian4.Notice(t("\u5B50\u8B70\u984C\u5EFA\u8B70\u5B8C\u6210\uFF1A{0} \u9805\u3002\u9EDE\u9078\u7BC0\u9EDE\u5F8C\u53EF\u67E5\u770B\u3002", suggestions.length));
    } catch (error) {
      console.error("Visual Agent Map AI split", error);
      new import_obsidian4.Notice(error instanceof Error ? error.message : String(error));
    } finally {
      this.plugin.running.delete(parent.path);
      await this.hydrate();
      this.render();
    }
  }
  openChildSuggestions(parent, suggestions) {
    new ChildProposalModal(this.app, suggestions.slice(0, 7), (items) => this.enqueue(async () => {
      this.plugin.pendingSuggestions.delete(parent.path);
      for (const item of items) {
        await this.addNode(parent, item.title);
        const child = this.map.nodes.at(-1);
        await this.noteChange(child, { prompt: item.task, detail: item.contribution ? canonicalDetail(item.contribution) : "" });
      }
    })).open();
  }
  async ancestorContext(node) {
    var _a;
    const chain = [], seen = /* @__PURE__ */ new Set([node.id]);
    let parent = node.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const n = (_a = this.map) == null ? void 0 : _a.nodes.find((item) => item.id === parent);
      if (!n) break;
      chain.unshift(n);
      parent = n.parentId;
    }
    const ancestors = [];
    for (const n of chain) {
      const info = await this.plugin.repo.readNote(n.path);
      ancestors.push(`- ${info.title}
  \u76EE\u524D\u7406\u89E3\uFF1A${info.summary}
  AI \u898F\u5247\uFF1A${info.rules || "\uFF08\u7121\uFF09"}`);
    }
    return ancestors.join("\n");
  }
  referenceSourcePaths(note, ownerPath) {
    if (note.sourcePaths.length) return [...new Set(note.sourcePaths)];
    const markers = ["### \u6574\u5408\u4F86\u6E90\uFF08\u4FDD\u5B58\u5167\u5BB9\uFF09", "### \u8403\u53D6\u4F86\u6E90\uFF08\u5F37\u9023\u7D50\u5099\u4EFD\uFF09", "### \u8403\u53D6\u4F86\u6E90\uFF08\u5F31\u9023\u7D50\uFF09", "### \u5408\u4F75\u4F86\u6E90"];
    const marker2 = markers.find((value) => note.detail.includes(value));
    if (!marker2) return [];
    const section2 = note.detail.slice(note.detail.indexOf(marker2) + marker2.length);
    const paths = [...section2.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((match) => {
      var _a, _b;
      const link = match[1], direct = link.endsWith(".md") ? link : `${link}.md`;
      if (this.app.vault.getAbstractFileByPath(direct) instanceof import_obsidian4.TFile) return direct;
      return (_b = (_a = this.app.metadataCache.getFirstLinkpathDest(link, ownerPath)) == null ? void 0 : _a.path) != null ? _b : direct;
    });
    return [...new Set(paths)];
  }
  async integrateChildren(node, confirmed = false) {
    if (!this.map || this.plugin.running.has(node.path)) return;
    const note = await this.plugin.repo.readNote(node.path);
    const children = this.map.nodes.filter((item) => item.parentId === node.id);
    if (!children.length) {
      new import_obsidian4.Notice(t("\u9019\u500B\u8B70\u984C\u76EE\u524D\u6C92\u6709\u76F4\u5C6C\u5B50\u8B70\u984C\u3002"));
      return;
    }
    if (!confirmed) {
      new ChoiceModal(this.app, t("\u78BA\u8A8D\u6574\u5408\u5B50\u8B70\u984C"), t("AI \u6703\u8B80\u53D6 {0} \u500B\u76F4\u5C6C\u5B50\u8B70\u984C\uFF1B\u5B8C\u6210\u5F8C\u76F4\u63A5\u66F4\u65B0\u76EE\u524D\u7406\u89E3\u8207 MD \u8A73\u60C5\u3002\n\n\u672C\u6B21\u5957\u7528\u7684 AI \u898F\u5247\uFF1A\n{1}", children.length, note.rules.trim() || "\u672A\u8A2D\u5B9A\u984D\u5916\u898F\u5247\u3002"), [
        { label: t("\u4F7F\u7528 {0}", note.model), description: t("\u9019\u6703\u57F7\u884C\u4E00\u6B21\u9AD8\u63A8\u7406 AI \u4EFB\u52D9\u3002"), buttonLabel: t("\u78BA\u8A8D\u4E26\u57F7\u884C"), action: () => this.enqueue(() => this.integrateChildren(node, true)) }
      ]).open();
      return;
    }
    const sourceContext = await this.sourceDigest(children, children.length <= 3 ? "strong" : "summary");
    const task = "\u6839\u64DA\u76F4\u5C6C\u5B50\u8B70\u984C\u7684\u5B8C\u6574\u77E5\u8B58\uFF0C\u66F4\u65B0\u6BCD\u8B70\u984C\u7684\u76EE\u524D\u7406\u89E3\u8207\u7D50\u69CB\u5316\u77E5\u8B58\uFF1B\u5408\u4F75\u91CD\u8907\u8CC7\u8A0A\uFF0C\u6E05\u695A\u6A19\u793A\u5171\u8B58\u3001\u5DEE\u7570\u3001\u53D6\u6368\u8207\u5F85\u78BA\u8A8D\u4E8B\u9805\u3002";
    this.plugin.running.add(node.path);
    await this.plugin.repo.updateNote(node.path, { status: "running" });
    await this.hydrate();
    this.render();
    try {
      const result = await this.plugin.askModel({ title: note.title, summary: note.summary, rules: note.rules, detail: note.detail, task, ancestors: await this.ancestorContext(node), sourceContext, mode: "synthesize" }, note.model);
      await this.plugin.repo.updateNote(node.path, { summary: result.summary, detail: canonicalDetail(result.detail), visualReferences: visualReferencesMarkdown(result.visualReferences), newFindings: "", status: "completed" });
      new import_obsidian4.Notice(t("\u5B50\u8B70\u984C\u6574\u5408\u5DF2\u5BEB\u5165\u76EE\u524D\u7406\u89E3\u8207 MD \u8A73\u60C5\u3002"));
    } catch (error) {
      console.error("Visual Agent Map child integration", error);
      await this.plugin.repo.updateNote(node.path, { status: "error" });
      new import_obsidian4.Notice(error instanceof Error ? error.message : String(error));
    } finally {
      this.plugin.running.delete(node.path);
      await this.hydrate();
      this.render();
    }
  }
  integrateSelected() {
    if (!this.map || this.multiSelected.size < 2) {
      new import_obsidian4.Notice(t("\u8ACB\u81F3\u5C11\u9078\u53D6\u5169\u500B\u8B70\u984C\u3002"));
      return;
    }
    const nodes = [...this.multiSelected].map((id) => this.map.nodes.find((node) => node.id === id)).filter((node) => !!node);
    const notes = nodes.map((node) => this.notes.get(node.id)).filter((note) => !!note);
    const sharedRules = notes.length && notes.every((note) => note.rules === notes[0].rules) ? notes[0].rules : "";
    new IntegrationModal(this.app, notes.map((note) => note.title), sharedRules, (title, goal, rules) => this.enqueue(() => this.createIntegratedNode(title, nodes, goal, rules))).open();
  }
  async sourceDigest(sources, mode = "strong") {
    if (mode === "weak") return sources.map((source) => `- [[${source.path.replace(/\.md$/, "")}]]`).join("\n");
    const notes = await Promise.all(sources.map((source) => this.plugin.repo.readNote(source.path)));
    return sources.map((source, index) => {
      const note = notes[index];
      const finding = note.newFindings.trim();
      return [
        `- [[${source.path.replace(/\.md$/, "")}]]`,
        `  - \u76EE\u524D\u7406\u89E3\uFF1A${note.summary || "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6"}`,
        mode === "strong" && note.detail.trim() ? `  - \u5B8C\u6574\u77E5\u8B58\uFF1A
${note.detail.trim().split("\n").map((line) => `    ${line}`).join("\n")}` : "",
        finding ? `  - \u820A\u7248\u5F85\u6574\u7406\u767C\u73FE\uFF1A${finding}` : ""
      ].filter(Boolean).join("\n");
    }).join("\n");
  }
  async extractedSourceContext(note) {
    if (note.sourcePaths.length) {
      const lines2 = [];
      for (const path of note.sourcePaths) {
        try {
          lines2.push((await this.sourceDigest([{ id: path, path, parentId: null, x: 0, y: 0, collapsed: false }], "strong")).trim());
        } catch (e) {
          lines2.push(`- [[${path.replace(/\.md$/, "")}]]
  - \u4F86\u6E90\u8B80\u53D6\u5931\u6557\u6216\u5DF2\u79FB\u52D5\u3002`);
        }
      }
      return lines2.join("\n");
    }
    for (const marker2 of ["### \u6574\u5408\u4F86\u6E90\uFF08\u4FDD\u5B58\u5167\u5BB9\uFF09", "### \u8403\u53D6\u4F86\u6E90\uFF08\u5F37\u9023\u7D50\u5099\u4EFD\uFF09", "### \u5408\u4F75\u4F86\u6E90"]) {
      const index = note.detail.indexOf(marker2);
      if (index >= 0) return note.detail.slice(index + marker2.length).trim();
    }
    const weakMarker = "### \u8403\u53D6\u4F86\u6E90\uFF08\u5F31\u9023\u7D50\uFF09";
    const weakIndex = note.detail.indexOf(weakMarker);
    if (weakIndex < 0) return "";
    const sourceSection = note.detail.slice(weakIndex + weakMarker.length);
    const paths = [...sourceSection.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((match) => `${match[1]}.md`);
    const unique = [...new Set(paths)];
    const lines = [];
    for (const path of unique) {
      try {
        lines.push((await this.sourceDigest([{ id: path, path, parentId: null, x: 0, y: 0, collapsed: false }], "strong")).trim());
      } catch (e) {
        lines.push(`- [[${path.replace(/\.md$/, "")}]]
  - \u4F86\u6E90\u8B80\u53D6\u5931\u6557\u6216\u5DF2\u79FB\u52D5\u3002`);
      }
    }
    return lines.join("\n");
  }
  async createIntegratedNode(title, sources, goal, rules) {
    if (!this.map || sources.length < 2) return;
    this.integrationMode = false;
    this.multiSelected.clear();
    this.render();
    const model = this.plugin.settings.cliModel;
    const sourceText = await this.sourceDigest(sources, "strong");
    const result = await this.plugin.askModel({ title, summary: "\u5C1A\u672A\u5F62\u6210\u7D50\u8AD6", rules, detail: "", task: goal, ancestors: "", sourceContext: sourceText, mode: "synthesize" }, model);
    const integrated = await this.plugin.repo.createNote(title, model, this.map, this.path, "workspace");
    await this.plugin.repo.updateNote(integrated.path, { summary: result.summary, rules, detail: canonicalDetail(result.detail), visualReferences: visualReferencesMarkdown(result.visualReferences), prompt: goal, sourcePaths: sources.map((source) => source.path), status: "completed" });
    integrated.parentId = null;
    integrated.x = Math.max(...sources.map((node) => node.x)) + 340;
    integrated.y = sources.reduce((sum, node) => sum + node.y, 0) / sources.length;
    this.notes.set(integrated.id, await this.plugin.repo.readNote(integrated.path));
    this.selected = integrated.id;
    this.multiSelected.clear();
    this.integrationMode = false;
    await this.mapChange((map) => {
      map.nodes.push(integrated);
    });
    await this.hydrate();
    this.render();
    this.focusNode(integrated);
  }
  transform() {
    var _a;
    if (!this.map || !this.stageEl) return;
    const { x, y, zoom } = this.map.viewport;
    this.stageEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    (_a = this.zoomLabel) == null ? void 0 : _a.setText(`${Math.round(zoom * 100)}%`);
  }
  saveViewport() {
    if (this.viewportTimer !== null) window.clearTimeout(this.viewportTimer);
    this.viewportTimer = window.setTimeout(() => {
      this.viewportTimer = null;
      this.enqueue(() => this.persist());
    }, 250);
  }
  zoomBy(factor, point) {
    if (!this.map || !this.viewportEl) return;
    const center = point != null ? point : { x: this.viewportEl.clientWidth / 2, y: this.viewportEl.clientHeight / 2 }, v = this.map.viewport;
    const zoom = Math.min(2, Math.max(0.25, v.zoom * factor)), ratio = zoom / v.zoom;
    v.x = center.x - (center.x - v.x) * ratio;
    v.y = center.y - (center.y - v.y) * ratio;
    v.zoom = zoom;
    this.transform();
    this.saveViewport();
  }
  focusNode(node) {
    if (!this.map || !this.viewportEl) return;
    const v = this.map.viewport;
    v.x = this.viewportEl.clientWidth / 2 - (node.x + 140) * v.zoom;
    v.y = this.viewportEl.clientHeight / 2 - (node.y + 80) * v.zoom;
    this.transform();
    this.saveViewport();
  }
  fit() {
    if (!this.map || !this.viewportEl) return;
    const nodes = visibleNodes(this.map.nodes);
    if (!nodes.length) return;
    const minX = Math.min(...nodes.map((n) => n.x)), maxX = Math.max(...nodes.map((n) => n.x + 280));
    const minY = Math.min(...nodes.map((n) => n.y)), maxY = Math.max(...nodes.map((n) => {
      var _a, _b, _c;
      return n.y + ((_c = (_b = (_a = this.stageEl) == null ? void 0 : _a.querySelector(`[data-node-id="${CSS.escape(n.id)}"]`)) == null ? void 0 : _b.offsetHeight) != null ? _c : 180);
    }));
    const width = this.viewportEl.clientWidth, height = this.viewportEl.clientHeight;
    const zoom = Math.max(0.25, Math.min(1.2, (width - 80) / (maxX - minX), (height - 80) / (maxY - minY)));
    this.map.viewport = { zoom, x: (width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (height - (maxY - minY) * zoom) / 2 - minY * zoom };
    this.transform();
    this.saveViewport();
  }
  setupPan() {
    const viewport = this.viewportEl;
    viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      this.zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 0 ? 2e-3 : 0.04)), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".vam-node") || event.button !== 0 || !this.map) return;
      const x = event.clientX, y = event.clientY, origin = { ...this.map.viewport };
      let moved = false;
      viewport.setPointerCapture(event.pointerId);
      viewport.addClass("is-panning");
      const move = (e) => {
        moved || (moved = Math.hypot(e.clientX - x, e.clientY - y) > 3);
        this.map.viewport.x = origin.x + e.clientX - x;
        this.map.viewport.y = origin.y + e.clientY - y;
        this.transform();
      };
      const up = () => {
        viewport.removeEventListener("pointermove", move);
        viewport.removeEventListener("pointerup", up);
        viewport.removeEventListener("pointercancel", up);
        viewport.removeClass("is-panning");
        this.saveViewport();
        if (!moved && !this.integrationMode) {
          this.selected = null;
          this.multiSelected.clear();
          this.render();
        }
      };
      viewport.addEventListener("pointermove", move);
      viewport.addEventListener("pointerup", up);
      viewport.addEventListener("pointercancel", up);
    });
  }
  enableDrag(card, node) {
    card.addEventListener("pointerdown", (event) => {
      var _a;
      if (this.integrationMode || event.target.closest("button") || event.button !== 0 || !this.map) return;
      this.clearHoverTimer();
      (_a = this.hoverCard) == null ? void 0 : _a.remove();
      this.hoverCard = null;
      this.dragging = true;
      const currentNode = this.map.nodes.find((item) => item.id === node.id);
      if (!currentNode) {
        this.dragging = false;
        return;
      }
      const start = { x: event.clientX, y: event.clientY }, origin = { x: currentNode.x, y: currentNode.y };
      let position = { ...origin }, moved = false;
      card.setPointerCapture(event.pointerId);
      const move = (e) => {
        moved || (moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3);
        if (!moved) return;
        position = { x: origin.x + (e.clientX - start.x) / this.map.viewport.zoom, y: origin.y + (e.clientY - start.y) / this.map.viewport.zoom };
        card.style.left = `${position.x}px`;
        card.style.top = `${position.y}px`;
        this.drawEdges();
      };
      const finish = (e) => {
        this.dragging = false;
        this.suppressClickUntil = moved ? Date.now() + 250 : 0;
        card.removeEventListener("pointermove", move);
        card.removeEventListener("pointerup", finish);
        card.removeEventListener("pointercancel", finish);
        if (e.type === "pointercancel") {
          card.style.left = `${origin.x}px`;
          card.style.top = `${origin.y}px`;
          this.drawEdges();
          return;
        }
        if (moved) this.enqueue(() => this.mapChange((map) => {
          const current = map.nodes.find((n) => n.id === node.id);
          if (!current) return;
          current.x = Math.round(position.x);
          current.y = Math.round(position.y);
        }));
        else if (e.metaKey || e.ctrlKey) {
          if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id);
          else this.multiSelected.add(node.id);
          this.selected = node.id;
          this.render();
        } else {
          this.multiSelected.clear();
          this.selected = node.id;
          this.render();
        }
      };
      card.addEventListener("pointermove", move);
      card.addEventListener("pointerup", finish);
      card.addEventListener("pointercancel", finish);
    });
  }
  drawEdges() {
    if (!this.edgesEl || !this.stageEl || !this.map) return;
    this.edgesEl.replaceChildren();
    for (const node of visibleNodes(this.map.nodes)) {
      if (!node.parentId) continue;
      const parent = this.stageEl.querySelector(`[data-node-id="${CSS.escape(node.parentId)}"]`), child = this.stageEl.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
      if (!parent || !child) continue;
      const x1 = parent.offsetLeft + parent.offsetWidth, y1 = parent.offsetTop + parent.offsetHeight / 2, x2 = child.offsetLeft, y2 = child.offsetTop + child.offsetHeight / 2, bend = Math.max(60, Math.abs(x2 - x1) / 2);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
      path.addClass("vam-edge");
      this.edgesEl.appendChild(path);
    }
  }
  async runAgent(node) {
    const note = await this.plugin.repo.readNote(node.path);
    if (!note.prompt) {
      new import_obsidian4.Notice(t("\u8ACB\u5148\u8F38\u5165\u8981\u4EA4\u7D66 AI \u7684\u554F\u984C\u6216\u4EFB\u52D9\u3002"));
      return;
    }
    if (this.plugin.running.has(node.path)) return;
    const context = { title: note.title, summary: note.summary, rules: note.rules, detail: note.detail, task: note.prompt, ancestors: await this.ancestorContext(node), workingFindings: note.newFindings, sourceContext: await this.extractedSourceContext(note), mode: "task" };
    this.plugin.pendingSuggestions.delete(node.path);
    this.plugin.running.add(node.path);
    try {
      await this.plugin.repo.updateNote(node.path, { status: "running" });
    } catch (error) {
      this.plugin.running.delete(node.path);
      throw error;
    }
    await this.hydrate();
    this.render();
    void this.plugin.askModel(context, note.model).then((result) => this.plugin.mutate(async () => {
      await this.plugin.repo.updateNote(node.path, { summary: result.summary, detail: canonicalDetail(result.detail), visualReferences: visualReferencesMarkdown(result.visualReferences), newFindings: "", status: "completed" });
      for (const view of this.plugin.views()) view.history.clear();
      if (result.suggestions.length) this.plugin.pendingSuggestions.set(node.path, result.suggestions.slice(0, 7));
    })).catch((error) => this.plugin.mutate(async () => {
      console.error("Visual Agent Map AI task", error);
      await this.plugin.repo.updateNote(node.path, { status: "error" });
      new import_obsidian4.Notice(error instanceof Error ? t("AI \u4EFB\u52D9\u5931\u6557\uFF1A{0}", error.message) : t("AI \u4EFB\u52D9\u5931\u6557\u3002"));
    })).finally(() => {
      this.plugin.running.delete(node.path);
      for (const view of this.plugin.views()) view.enqueue(async () => {
        await view.hydrate();
        view.render();
      });
    }).catch(() => {
    });
  }
};
var VisualAgentMapSettingTab = class extends import_obsidian4.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Visual Agent Map" });
    new import_obsidian4.Setting(this.containerEl).setName(t("\u4ECB\u9762\u8A9E\u8A00")).addDropdown((input) => input.addOption("zh-TW", "\u7E41\u9AD4\u4E2D\u6587").addOption("en", "English").setValue(this.plugin.settings.language).onChange(async (value) => {
      this.plugin.settings.language = value === "en" ? "en" : "zh-TW";
      setUiLanguage(this.plugin.settings.language);
      await this.plugin.saveSettings();
      for (const view of this.plugin.views()) await view.refreshFromPlugin();
      this.display();
    }));
    this.containerEl.createEl("p", { text: t("\u4F7F\u7528\u672C\u6A5F Codex ACP / Claude Code \u767B\u5165\u72C0\u614B\u3002AI \u4EFB\u52D9\u5B8C\u6210\u5F8C\u6703\u76F4\u63A5\u66F4\u65B0\u76EE\u524D\u7406\u89E3\uFF0C\u5B8C\u6574\u7D50\u679C\u4FDD\u5B58\u5728\u8B70\u984C MD \u8A73\u60C5\u4E2D\u3002") });
    const text = (name, key, desc) => {
      new import_obsidian4.Setting(this.containerEl).setName(name).setDesc(desc).addText((input) => input.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value.trim();
        await this.plugin.saveSettings();
      }));
    };
    text(t("Codex ACP \u8DEF\u5F91"), "codexAcpPath", t("\u7528\u65BC\u5E38\u99D0 Codex session \u8207\u81EA\u52D5\u53D6\u5F97\u6A21\u578B\u6E05\u55AE\u3002"));
    text(t("Claude Code CLI \u8DEF\u5F91"), "claudePath", t("\u7528\u65BC claude:sonnet\u3001claude:opus\u3001claude:fable\uFF1B\u9700\u5148\u5B8C\u6210 Claude Code \u767B\u5165\u3002"));
    text(t("\u5DE5\u4F5C\u5340\u9810\u8A2D Model"), "cliModel", t("\u76EE\u524D\u6700\u4F4E\u6210\u672C\u6A21\u578B\u70BA gpt-5.6-luna\uFF1B\u8B8A\u66F4\u53EA\u5F71\u97FF\u4E4B\u5F8C\u65B0\u589E\u7684\u6839\u8B70\u984C\u3002"));
    text(t("Model \u9078\u55AE"), "models", t("\u555F\u52D5\u5F8C\u6703\u512A\u5148\u88DC\u5165 Codex ACP \u56DE\u5831\u7684\u6A21\u578B\uFF1BClaude Code \u8ACB\u4F7F\u7528 claude:sonnet\u3001claude:opus \u6216 claude:fable\u3002"));
    this.containerEl.createEl("p", { cls: "setting-item-description", text: t("\u4E00\u822C\u4EFB\u52D9\u4F7F\u7528\u4F4E\u63A8\u7406\uFF1B\u6574\u5408\u5B50\u8B70\u984C\u4F7F\u7528\u9AD8\u63A8\u7406\u3002") });
    const advanced = this.containerEl.createEl("details");
    advanced.createEl("summary", { text: "Advanced" });
    new import_obsidian4.Setting(advanced).setName(t("Codex CLI fallback \u8DEF\u5F91")).setDesc(t("\u53EA\u6709 Codex ACP \u5931\u6557\u6642\u624D\u4F7F\u7528\u3002")).addText((input) => input.setValue(this.plugin.settings.cliPath).onChange(async (value) => {
      this.plugin.settings.cliPath = value.trim();
      await this.plugin.saveSettings();
    }));
    this.containerEl.createEl("p", { text: t("\u4E3B\u984C\u8CC7\u6599\u593E\uFF1A{0}\u3000\u672A\u5206\u985E\u6536\u4EF6\u5323\uFF1A{1}", this.plugin.settings.topicsFolder, this.plugin.settings.inboxFolder) });
  }
};
var VisualAgentMapPlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    __publicField(this, "settings", { ...DEFAULT_SETTINGS });
    __publicField(this, "repo");
    __publicField(this, "ready", Promise.resolve());
    __publicField(this, "running", /* @__PURE__ */ new Set());
    __publicField(this, "pendingSuggestions", /* @__PURE__ */ new Map());
    __publicField(this, "childProcesses", /* @__PURE__ */ new Set());
    __publicField(this, "acp", null);
    __publicField(this, "acpConfigIds", { model: "model", reasoning: "" });
    __publicField(this, "detailsLeaf", null);
    __publicField(this, "queue", Promise.resolve());
    __publicField(this, "writing", 0);
    __publicField(this, "providers", new ProviderRegistry(
      { id: "codex", run: async (context, model) => this.runCodex(context, model) },
      { id: "claude", run: async (context, model) => this.runClaude(context, model) }
    ));
  }
  async mutate(work) {
    const result = this.queue.then(async () => {
      this.writing++;
      try {
        await work();
        for (const view of this.views()) await view.synchronize();
      } finally {
        this.writing--;
      }
    });
    this.queue = result.catch((error) => {
      console.error("Visual Agent Map", error);
      new import_obsidian4.Notice(error instanceof Error ? error.message : String(error));
    });
    return result;
  }
  views() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((leaf) => leaf.view).filter((view) => view instanceof VisualAgentMapView);
  }
  async onload() {
    var _a;
    const saved = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, language: (saved == null ? void 0 : saved.language) === "en" ? "en" : "zh-TW", workspaceFolder: (saved == null ? void 0 : saved.workspaceFolder) || DEFAULT_SETTINGS.workspaceFolder, topicsFolder: (saved == null ? void 0 : saved.topicsFolder) || DEFAULT_SETTINGS.topicsFolder, inboxFolder: (saved == null ? void 0 : saved.inboxFolder) || DEFAULT_SETTINGS.inboxFolder, notesFolder: (saved == null ? void 0 : saved.notesFolder) || DEFAULT_SETTINGS.notesFolder, mapsFolder: (saved == null ? void 0 : saved.mapsFolder) || DEFAULT_SETTINGS.mapsFolder, mapId: (saved == null ? void 0 : saved.mapId) || "default", cliPath: (saved == null ? void 0 : saved.cliPath) || DEFAULT_SETTINGS.cliPath, codexAcpPath: (saved == null ? void 0 : saved.codexAcpPath) || DEFAULT_SETTINGS.codexAcpPath, claudePath: (saved == null ? void 0 : saved.claudePath) || DEFAULT_SETTINGS.claudePath, cliModel: (saved == null ? void 0 : saved.cliModel) || DEFAULT_SETTINGS.cliModel, cliReasoning: (saved == null ? void 0 : saved.cliReasoning) || DEFAULT_SETTINGS.cliReasoning, previewScale: (saved == null ? void 0 : saved.previewScale) !== void 0 ? clampPreviewScale(saved.previewScale) : legacyPreviewScale(saved == null ? void 0 : saved.previewSize), models: (saved == null ? void 0 : saved.models) || DEFAULT_SETTINGS.models, migrated: (saved == null ? void 0 : saved.migrated) === true, structureVersion: (_a = saved == null ? void 0 : saved.structureVersion) != null ? _a : saved ? 1 : DEFAULT_SETTINGS.structureVersion, firstUseNoticeSeen: (saved == null ? void 0 : saved.firstUseNoticeSeen) === true };
    setUiLanguage(this.settings.language);
    this.repo = new Repository(this.app, this.settings);
    const initialize = (this.settings.migrated ? Promise.resolve() : this.repo.migrate().then(async () => {
      await this.repo.rebuildDerivedData();
      this.settings.migrated = true;
    })).then(async () => {
      if (this.settings.structureVersion < 2) {
        const count = await this.repo.normalizeGeneratedNoteFilenames();
        this.settings.structureVersion = 2;
        await this.saveSettings();
        if (count) new import_obsidian4.Notice(t("\u5DF2\u5C07 {0} \u4EFD\u5B50\u8B70\u984C\u6A94\u540D\u540C\u6B65\u70BA\u8B70\u984C\u540D\u7A31\u3002", count));
      }
    });
    this.ready = initialize;
    this.registerView(VIEW_TYPE, (leaf) => new VisualAgentMapView(leaf, this));
    this.addRibbonIcon("git-fork", "Open Visual Agent Map", () => {
      void this.activateView().catch((error) => new import_obsidian4.Notice(String(error)));
    });
    this.addCommand({ id: "open-visual-agent-map", name: "Open visual agent map", callback: () => {
      void this.activateView().catch((error) => new import_obsidian4.Notice(String(error)));
    } });
    this.addCommand({ id: "rebuild-visual-agent-map-references", name: t("\u91CD\u5EFA\u8B70\u984C reference"), callback: () => {
      void this.mutate(async () => {
        await this.repo.rebuildDerivedData();
        new import_obsidian4.Notice(t("\u8B70\u984C reference \u5DF2\u4F9D\u5FC3\u667A\u5716\u91CD\u5EFA\u3002"));
      });
    } });
    this.addCommand({ id: "normalize-visual-agent-map-note-filenames", name: t("\u540C\u6B65\u8B70\u984C\u540D\u7A31\u8207\u6A94\u540D"), callback: () => {
      void this.mutate(async () => {
        const count = await this.repo.normalizeGeneratedNoteFilenames();
        new import_obsidian4.Notice(count ? t("\u5DF2\u540C\u6B65 {0} \u4EFD\u8B70\u984C\u6A94\u540D\u3002", count) : t("\u8B70\u984C\u6A94\u540D\u5DF2\u662F\u6700\u65B0\u72C0\u614B\u3002"));
      });
    } });
    this.addSettingTab(new VisualAgentMapSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (file instanceof import_obsidian4.TFile && this.isMap(file)) menu.addItem((item) => item.setTitle(t("\u4EE5\u5FC3\u667A\u5716\u958B\u555F")).setIcon("git-fork").onClick(() => {
        void this.activateView(file.path);
      }));
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      this.styleNodeLeaf(leaf);
      if (!((leaf == null ? void 0 : leaf.view) instanceof import_obsidian4.MarkdownView) || !leaf.view.file || !this.isMap(leaf.view.file)) return;
      const path = leaf.view.file.path;
      void leaf.setViewState({ type: VIEW_TYPE, state: { file: path }, active: true }).catch((error) => new import_obsidian4.Notice(error instanceof Error ? error.message : String(error)));
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) this.styleNodeLeaf(leaf);
    }));
    this.app.workspace.onLayoutReady(() => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) this.styleNodeLeaf(leaf);
      if (!this.settings.firstUseNoticeSeen) new FirstUseModal(this.app, () => {
        this.settings.firstUseNoticeSeen = true;
        void this.saveSettings();
      }).open();
      void this.ready.then(() => this.repo.ensureNodePresentation()).catch((error) => {
        console.error("Visual Agent Map topic presentation", error);
        new import_obsidian4.Notice(t("\u7121\u6CD5\u5957\u7528\u8B70\u984C\u7B46\u8A18\u986F\u793A\u8A2D\u5B9A\uFF1A{0}", error instanceof Error ? error.message : String(error)));
      });
      void this.ready.then(() => this.refreshCodexAcpModels()).catch((error) => console.warn("Visual Agent Map Codex ACP model refresh", error));
    });
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!this.writing && file instanceof import_obsidian4.TFile) for (const view of this.views()) view.changed(file);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!this.writing && file instanceof import_obsidian4.TFile) {
        for (const view of this.views()) view.deleted(file);
        if (file.path.startsWith(`${this.settings.mapsFolder}/`) || file.path.startsWith(`${this.settings.topicsFolder}/`) && file.name === "Map.md") void this.mutate(() => this.repo.rebuildDerivedData());
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!this.writing && file instanceof import_obsidian4.TFile) void this.mutate(async () => {
        await this.repo.replaceSourcePath(oldPath, file.path);
        for (const mapFile of await this.repo.mapFiles()) {
          const map = await this.repo.readMap(mapFile.path);
          let changed = false;
          for (const node of map.nodes) if (node.path === oldPath) {
            node.path = file.path;
            changed = true;
          }
          if (changed) await this.repo.saveMap(mapFile.path, map);
        }
        await this.rebuildDerivedData();
        for (const view of this.views()) await view.renamed(file, oldPath);
      });
    }));
  }
  isMap(file) {
    var _a, _b;
    const marker2 = (_b = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter) == null ? void 0 : _b["visual-agent-map"];
    return marker2 === true || marker2 === "true" || file.extension === "md" && (file.path.startsWith(`${this.settings.mapsFolder}/`) || file.path.startsWith(`${this.settings.topicsFolder}/`) && file.name === "Map.md");
  }
  isNode(file) {
    var _a, _b;
    const marker2 = (_b = (_a = this.app.metadataCache.getFileCache(file)) == null ? void 0 : _a.frontmatter) == null ? void 0 : _b["agent-map-node"];
    return marker2 === true || marker2 === "true" || file.extension === "md" && (file.path.startsWith(`${this.settings.notesFolder}/`) || file.path.startsWith(`${this.settings.topicsFolder}/`) || file.path.startsWith(`${this.settings.inboxFolder}/`));
  }
  styleNodeLeaf(leaf) {
    if (!((leaf == null ? void 0 : leaf.view) instanceof import_obsidian4.MarkdownView)) return;
    leaf.view.containerEl.toggleClass("vam-topic-markdown", !!leaf.view.file && this.isNode(leaf.view.file));
  }
  onunload() {
    if (this.acp) {
      this.acp.child.kill();
      this.acp = null;
    }
    for (const child of this.childProcesses) child.kill();
    this.childProcesses.clear();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async rebuildDerivedData() {
    try {
      await this.repo.rebuildDerivedData();
    } catch (error) {
      console.error("Visual Agent Map reference rebuild", error);
      new import_obsidian4.Notice(t("\u5FC3\u667A\u5716\u5DF2\u5132\u5B58\uFF0C\u4F46 reference \u66F4\u65B0\u5931\u6557\uFF1A{0}", error instanceof Error ? error.message : String(error)));
    }
  }
  async openDetails(file) {
    var _a, _b;
    const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
    if (this.detailsLeaf && (!markdownLeaves.includes(this.detailsLeaf) || this.detailsLeaf.getRoot() !== this.app.workspace.rightSplit)) this.detailsLeaf = null;
    if (!this.detailsLeaf) {
      this.detailsLeaf = (_b = (_a = markdownLeaves.filter((leaf) => {
        var _a2, _b2;
        return leaf.getRoot() === this.app.workspace.rightSplit && leaf.view instanceof import_obsidian4.MarkdownView && !!leaf.view.file && ((_b2 = (_a2 = this.app.metadataCache.getFileCache(leaf.view.file)) == null ? void 0 : _a2.frontmatter) == null ? void 0 : _b2["agent-map-node"]) === true;
      }).sort((a, b) => a.view.containerEl.getBoundingClientRect().top - b.view.containerEl.getBoundingClientRect().top)[0]) != null ? _a : this.app.workspace.getRightLeaf(false)) != null ? _b : this.app.workspace.getRightLeaf(true);
    }
    if (!this.detailsLeaf) throw new Error(t("\u7121\u6CD5\u958B\u555F\u53F3\u5074\u8A73\u60C5\u6B04\u3002"));
    await this.detailsLeaf.openFile(file);
    this.styleNodeLeaf(this.detailsLeaf);
    await this.app.workspace.revealLeaf(this.detailsLeaf);
  }
  async activateView(path) {
    await this.ready;
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: path ? { file: path } : leaf.view instanceof VisualAgentMapView ? leaf.view.getState() : {} });
    await this.app.workspace.revealLeaf(leaf);
  }
  async refreshCodexAcpModels() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian4.FileSystemAdapter) || !this.manifest.dir) return;
    const pluginDirectory = (0, import_node_path.join)(adapter.getBasePath(), this.manifest.dir);
    await this.ensureAcpProcess(pluginDirectory);
    for (const view of this.views()) await view.refreshFromPlugin();
  }
  async askModel(context, model) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian4.FileSystemAdapter)) throw new Error(t("CLI \u6A21\u5F0F\u53EA\u652F\u63F4\u684C\u9762\u7248 Obsidian"));
    if (!this.manifest.dir) throw new Error(t("\u627E\u4E0D\u5230\u5916\u639B\u76EE\u9304"));
    const totalStarted = Date.now();
    const prepared = buildPreparedTaskContext(context, model);
    context = prepared.context;
    const pluginDirectory = (0, import_node_path.join)(adapter.getBasePath(), this.manifest.dir);
    const schemaPath = (0, import_node_path.join)(pluginDirectory, "response-schema.json");
    const provider = this.providers.select(model);
    if (provider.id === "claude") return provider.run(context, this.providers.modelFor(provider, model));
    const instructions = [
      "\u4F60\u662F\u8996\u89BA\u5316\u601D\u8003 Agent\u3002\u4E0D\u8981\u4FEE\u6539\u4EFB\u4F55\u6A94\u6848\uFF1B\u9664\u975E\u4EFB\u52D9\u660E\u78BA\u6307\u5B9A\uFF0C\u5426\u5247\u4E0D\u8981\u8B80\u53D6\u672C\u6A5F\u6A94\u6848\u3002",
      '\u53EA\u56DE\u50B3 JSON\uFF0C\u4E0D\u8981\u4F7F\u7528 Markdown code fence\u3002\u683C\u5F0F\u5FC5\u9808\u7B26\u5408\uFF1A{"summary":"...","detail":"...","suggestions":[{"title":"...","task":"...","contribution":"..."}],"visualReferences":[{"title":"...","imageUrl":"https://...","sourceUrl":"https://...","description":"...","palette":["navy","white"],"formula":"..."}]}\u3002\u82E5\u6C92\u6709\u8996\u89BA\u53C3\u8003\uFF0CvisualReferences \u56DE\u50B3\u7A7A\u9663\u5217\u3002',
      context.mode === "task" ? "\u9019\u662F\u4E00\u822C\u4EFB\u52D9\uFF1Asummary \u5FC5\u9808\u662F\u4E00\u53E5\u9069\u5408\u5FC3\u667A\u5716\u986F\u793A\u7684\u65B0\u76EE\u524D\u7406\u89E3\uFF0C80 \u5B57\u5167\uFF1Bdetail \u662F\u6703\u76F4\u63A5\u53D6\u4EE3\u820A Detail \u7684\u5B8C\u6574\u77E5\u8B58\u9801\uFF0C\u5FC5\u9808\u5438\u6536\u820A\u5167\u5BB9\u8207\u672C\u6B21\u767C\u73FE\u3001\u53BB\u9664\u91CD\u8907\u3001\u4FDD\u7559\u4ECD\u6709\u6548\u7684\u4F86\u6E90\u3002\u82E5\u8B70\u984C\u904E\u65BC\u8907\u96DC\u624D\u63D0\u4F9B suggestions\uFF0C\u5426\u5247\u56DE\u50B3\u7A7A\u9663\u5217\u3002" : context.mode === "decompose" ? "\u9019\u662F Decompose \u6A21\u5F0F\uFF1A\u53EA\u7522\u751F 3\u20137 \u500B\u53EF\u7368\u7ACB\u8655\u7406\u7684\u5B50\u8B70\u984C suggestions\u3002summary \u7C21\u8FF0\u662F\u5426\u5EFA\u8B70\u62C6\u89E3\uFF0Cdetail \u7C21\u8FF0\u62C6\u89E3\u7406\u7531\uFF1B\u4E0D\u8981\u66F4\u65B0\u7D50\u8AD6\u3002" : context.mode === "synthesize" ? "\u9019\u662F Synthesize \u6A21\u5F0F\uFF1Asummary \u5FC5\u9808\u662F\u9AD8\u54C1\u8CEA\u6574\u5408\u7D50\u8AD6\uFF0C80 \u5B57\u5167\uFF1Bdetail \u5FC5\u9808\u6574\u5408\u4F86\u6E90\u5B8C\u6574\u77E5\u8B58\u3001\u6536\u6582\u91CD\u8907\u5167\u5BB9\u3001\u6E05\u695A\u5448\u73FE\u5171\u8B58\u3001\u5206\u6B67\u3001\u53D6\u6368\u8207\u672A\u89E3\u554F\u984C\uFF1B\u5B8C\u6210\u5F8C\u6703\u76F4\u63A5\u5BEB\u56DE\u3002" : "summary \u5FC5\u9808\u662F\u4E00\u53E5\u9069\u5408\u5FC3\u667A\u5716\u986F\u793A\u7684\u65B0\u76EE\u524D\u7406\u89E3\uFF0Cdetail \u5FC5\u9808\u662F\u5B8C\u6574\u7E41\u9AD4\u4E2D\u6587 Markdown \u5206\u6790\u3002",
      context.mode !== "decompose" ? "detail \u5FC5\u9808\u4E14\u53EA\u80FD\u4F9D\u5E8F\u4F7F\u7528\u4EE5\u4E0B\u516D\u500B\u4E09\u7D1A\u6A19\u984C\uFF1A### \u6838\u5FC3\u7D50\u8AD6\u3001### \u95DC\u9375\u77E5\u8B58\u3001### \u8B49\u64DA\u8207\u4F86\u6E90\u3001### \u53D6\u6368\u8207\u9650\u5236\u3001### \u5F85\u78BA\u8A8D\u4E8B\u9805\u3001### \u66F4\u65B0\u7D00\u9304\u3002\u66F4\u65B0\u7D00\u9304\u53EA\u65B0\u589E\u4E00\u884C\u672C\u6B21\u8B8A\u66F4\u6458\u8981\uFF0C\u4E0D\u53EF\u91CD\u8CBC\u5B8C\u6574\u7B54\u6848\uFF1B\u6C92\u6709\u5167\u5BB9\u7684\u6BB5\u843D\u5BEB\u300C\u5C1A\u5F85\u88DC\u5145\u300D\u3002" : "",
      context.mode !== "decompose" ? "\u82E5\u4EFB\u52D9\u9700\u8981\u8996\u89BA\u7406\u89E3\uFF08\u4F8B\u5982\u7A7F\u642D\u3001\u914D\u8272\u3001\u5BA4\u5167\u8A2D\u8A08\u3001\u98DF\u8B5C\u5916\u89C0\u3001UI \u53C3\u8003\uFF09\uFF0C\u8ACB\u63D0\u4F9B 1\u20136 \u500B\u5DF2\u641C\u5C0B\u5230\u7684\u5716\u7247\u53C3\u8003 visualReferences\uFF1B\u5FC5\u9808\u5305\u542B\u5716\u7247 URL \u8207\u4F86\u6E90\u9801 URL\uFF0C\u4E0D\u8981\u751F\u6210\u5716\u7247\uFF0C\u4E0D\u8981\u7DE8\u9020\u4F86\u6E90\u3002" : "",
      context.mode !== "decompose" ? "\u5716\u7247\u5FC5\u9808\u76F4\u63A5\u5D4C\u5165 detail \u7684\u76F8\u95DC\u8AAA\u660E\u6BB5\u843D\u4E4B\u5F8C\uFF0C\u4F7F\u7528 Markdown \u5716\u7247\u8A9E\u6CD5\uFF0C\u4E26\u5728\u5716\u7247\u4E0B\u65B9\u9644\u4F86\u6E90\u9801\u9023\u7D50\u3002\u4E0D\u8981\u5EFA\u7ACB\u8996\u89BA\u53C3\u8003\u3001\u5716\u793A\u6216\u5716\u7247\u96C6\u5408\u7684\u7368\u7ACB\u6BB5\u843D\uFF1B\u5716\u7247\u8207 visualReferences \u4F7F\u7528\u76F8\u540C URL\u3002\u512A\u5148\u641C\u5C0B\u53EF\u5E6B\u52A9\u7406\u89E3\u8B70\u984C\u7684\u76F8\u95DC\u5716\u7247\uFF0C\u627E\u4E0D\u5230\u53EF\u9760\u5716\u7247\u6642\u4E0D\u8981\u7DE8\u9020\u3002" : "",
      `\u76EE\u524D\u8B70\u984C\uFF1A
${context.title}`,
      `\u76EE\u524D\u7406\u89E3\uFF1A
${context.summary}`,
      context.mode !== "decompose" ? `\u73FE\u6709 Detail\uFF08\u9808\u6574\u5408\u5F8C\u5B8C\u6574\u53D6\u4EE3\uFF0C\u4E0D\u80FD\u539F\u6A23\u91CD\u8907\u8FFD\u52A0\uFF09\uFF1A
${context.detail || "\uFF08\u7121\uFF09"}` : "",
      `\u76EE\u524D\u8B70\u984C\u7684 AI \u898F\u5247\uFF08\u512A\u5148\u9075\u5B88\uFF09\uFF1A
${context.rules || "\uFF08\u7121\uFF09"}`,
      context.workingFindings ? `\u820A\u7248\u5F85\u6574\u7406\u767C\u73FE\uFF08\u672C\u6B21\u5FC5\u9808\u4E00\u4F75\u6536\u6582\uFF09\uFF1A
${context.workingFindings}` : "",
      context.sourceContext ? `\u6574\u5408\u4F86\u6E90\u80CC\u666F\uFF1A
${context.sourceContext}` : "",
      `\u7956\u5148\u8B70\u984C\u80CC\u666F\uFF1A
${context.ancestors || "\uFF08\u7121\uFF09"}`,
      `\u76EE\u524D\u4EFB\u52D9\uFF1A
${context.task}`
    ].join("\n\n");
    console.debug("Visual Agent Map AI metrics", prepared.metrics);
    const providerStarted = Date.now();
    try {
      const result = await this.askCodexAcp(instructions, model, pluginDirectory);
      console.debug("Visual Agent Map AI metrics", { ...prepared.metrics, providerMs: Date.now() - providerStarted, totalMs: Date.now() - totalStarted });
      return result;
    } catch (error) {
      if (!(error instanceof AcpTransportError)) throw error;
      console.warn("Visual Agent Map Codex ACP transport failed before prompting; falling back to Codex CLI", error);
      return this.askCodexExec(instructions, model, pluginDirectory, schemaPath);
    }
  }
  async runCodex(context, model) {
    return this.askModel(context, model);
  }
  async runClaude(context, model) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof import_obsidian4.FileSystemAdapter)) throw new Error(t("CLI \u6A21\u5F0F\u53EA\u652F\u63F4\u684C\u9762\u7248 Obsidian"));
    if (!this.manifest.dir) throw new Error(t("\u627E\u4E0D\u5230\u5916\u639B\u76EE\u9304"));
    const pluginDirectory = (0, import_node_path.join)(adapter.getBasePath(), this.manifest.dir);
    return this.askClaude(context, model, pluginDirectory, (0, import_node_path.join)(pluginDirectory, "response-schema.json"));
  }
  parseAiResult(raw, label) {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.summary !== "string" || typeof parsed.detail !== "string") throw new Error(`${label} \u6C92\u6709\u56DE\u50B3 summary \u8207 detail`);
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((item) => !!item && typeof item.title === "string" && typeof item.task === "string").map((item) => ({ title: item.title.trim(), task: item.task.trim(), contribution: typeof item.contribution === "string" ? item.contribution.trim() : "" })).filter((item) => item.title) : [];
    const visualReferences = Array.isArray(parsed.visualReferences) ? parsed.visualReferences.filter((item) => !!item && typeof item.imageUrl === "string" && typeof item.sourceUrl === "string").map((item) => ({
      title: typeof item.title === "string" ? item.title.trim() : "\u8996\u89BA\u53C3\u8003",
      imageUrl: item.imageUrl.trim(),
      sourceUrl: item.sourceUrl.trim(),
      description: typeof item.description === "string" ? item.description.trim() : "",
      palette: Array.isArray(item.palette) ? item.palette.map(String).map((color) => color.trim()).filter(Boolean).slice(0, 8) : [],
      formula: typeof item.formula === "string" ? item.formula.trim() : ""
    })).filter((item) => /^https?:\/\//i.test(item.imageUrl) && /^https?:\/\//i.test(item.sourceUrl)).slice(0, 6) : [];
    return { summary: Array.from(parsed.summary.trim()).slice(0, 80).join(""), detail: parsed.detail.trim(), suggestions, visualReferences };
  }
  acpSend(message) {
    if (!this.acp) throw new Error(t("Codex ACP \u5C1A\u672A\u555F\u52D5"));
    this.acp.child.stdin.write(`${JSON.stringify(message)}
`);
  }
  acpRequest(method, params, timeoutMs = method === "session/prompt" ? ACP_PROMPT_TIMEOUT_MS : ACP_CONTROL_TIMEOUT_MS) {
    if (!this.acp) throw new Error(t("Codex ACP \u5C1A\u672A\u555F\u52D5"));
    const id = this.acp.nextId++;
    const acp = this.acp;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (!acp.pending.delete(id)) return;
        reject(new AcpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      acp.pending.set(id, { resolve, reject, timeout });
      try {
        this.acpSend({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        window.clearTimeout(timeout);
        acp.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  acpRespond(id, result) {
    this.acpSend({ jsonrpc: "2.0", id, result });
  }
  handleAcpMessage(message) {
    var _a, _b, _c, _d;
    if ("id" in message && ("result" in message || "error" in message)) {
      const entry = (_a = this.acp) == null ? void 0 : _a.pending.get(message.id);
      if (!entry) return;
      (_b = this.acp) == null ? void 0 : _b.pending.delete(message.id);
      window.clearTimeout(entry.timeout);
      if (message.error) entry.reject(new Error(typeof message.error === "string" ? message.error : message.error.message || t("Codex ACP \u56DE\u50B3\u932F\u8AA4")));
      else entry.resolve(message.result);
      return;
    }
    if ("method" in message && message.method === "session/update") {
      const params = message.params;
      const sessionId = typeof (params == null ? void 0 : params.sessionId) === "string" ? params.sessionId : "";
      (_d = (_c = this.acp) == null ? void 0 : _c.sessions.get(sessionId)) == null ? void 0 : _d.updates.push(message.params);
      return;
    }
    if ("id" in message && "method" in message) {
      if (message.method === "session/request_permission") {
        this.acpRespond(message.id, { outcome: { outcome: "cancelled" } });
        return;
      }
      if (message.method === "terminal/create") {
        this.acpRespond(message.id, { terminalId: "visual-agent-map-denied" });
        return;
      }
      if (message.method === "terminal/output") {
        this.acpRespond(message.id, { output: "", truncated: false, exitStatus: { exitCode: 1 } });
        return;
      }
      if (message.method === "terminal/wait_for_exit") {
        this.acpRespond(message.id, { exitCode: 1 });
        return;
      }
      this.acpRespond(message.id, {});
    }
  }
  async ensureAcpProcess(pluginDirectory) {
    if (!this.acp) {
      const child = (0, import_node_child_process.spawn)(this.settings.codexAcpPath, [], { cwd: pluginDirectory, stdio: ["pipe", "pipe", "pipe"] });
      this.childProcesses.add(child);
      this.acp = { child, buffer: "", nextId: 1, pending: /* @__PURE__ */ new Map(), sessions: /* @__PURE__ */ new Map(), initializing: Promise.resolve() };
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        if (!this.acp || this.acp.child !== child) return;
        this.acp.buffer += chunk.toString("utf8");
        while (true) {
          const newline = this.acp.buffer.indexOf("\n");
          if (newline === -1) return;
          const line = this.acp.buffer.slice(0, newline).trim();
          this.acp.buffer = this.acp.buffer.slice(newline + 1);
          if (line) this.handleAcpMessage(JSON.parse(line));
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        var _a, _b, _c;
        for (const entry of (_b = (_a = this.acp) == null ? void 0 : _a.pending.values()) != null ? _b : []) {
          window.clearTimeout(entry.timeout);
          entry.reject(new AcpTransportError(`\u7121\u6CD5\u555F\u52D5 Codex ACP\uFF1A${error.message}`));
        }
        this.childProcesses.delete(child);
        if (((_c = this.acp) == null ? void 0 : _c.child) === child) this.acp = null;
      });
      child.on("close", (code) => {
        var _a, _b, _c;
        for (const entry of (_b = (_a = this.acp) == null ? void 0 : _a.pending.values()) != null ? _b : []) {
          window.clearTimeout(entry.timeout);
          entry.reject(new AcpTransportError(stderr.trim() || `Codex ACP \u7D50\u675F\u78BC\uFF1A${code != null ? code : "\u672A\u77E5"}`));
        }
        this.childProcesses.delete(child);
        if (((_c = this.acp) == null ? void 0 : _c.child) === child) this.acp = null;
      });
      this.acp.initializing = this.acpRequest("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "visual-agent-map", version: this.manifest.version || "0.0.0" } }).then(() => void 0);
    }
    try {
      await this.acp.initializing;
    } catch (error) {
      throw error instanceof AcpTransportError ? error : new AcpTransportError(error instanceof Error ? error.message : String(error));
    }
  }
  codexModelsFromConfig(configOptions) {
    if (!Array.isArray(configOptions)) return [];
    const option = configOptions.find((item) => {
      const record = item;
      return record.id === "model" || record.category === "model";
    });
    if (!Array.isArray(option == null ? void 0 : option.options)) return [];
    const flatten = (items) => items.flatMap((item) => {
      const record = item;
      if (Array.isArray(record.options)) return flatten(record.options);
      return typeof record.value === "string" ? [record.value] : [];
    });
    return flatten(option.options);
  }
  codexConfigIds(configOptions) {
    if (!Array.isArray(configOptions)) return { model: "model", reasoning: "" };
    const findId = (matches) => {
      const option = configOptions.find((item) => {
        const record = item;
        return matches.includes(String(record.id)) || matches.includes(String(record.category));
      });
      return typeof (option == null ? void 0 : option.id) === "string" ? option.id : "";
    };
    return { model: findId(["model"]) || "model", reasoning: findId(["reasoning", "reasoning-effort", "model_reasoning_effort"]) };
  }
  acpText(sessionId) {
    var _a, _b, _c;
    return ((_c = (_b = (_a = this.acp) == null ? void 0 : _a.sessions.get(sessionId)) == null ? void 0 : _b.updates) != null ? _c : []).map((item) => item.update).filter((update) => (update == null ? void 0 : update.sessionUpdate) === "agent_message_chunk" || (update == null ? void 0 : update.type) === "agent_message_chunk").map((update) => (update == null ? void 0 : update.text) || (update == null ? void 0 : update.content) || "").join("");
  }
  async askCodexAcp(prompt, model, pluginDirectory) {
    var _a, _b;
    await this.ensureAcpProcess(pluginDirectory);
    let session;
    try {
      session = await this.acpRequest("session/new", { cwd: pluginDirectory, mcpServers: [] });
    } catch (error) {
      throw error instanceof AcpTransportError ? error : new AcpSessionError(error instanceof Error ? error.message : String(error));
    }
    if (!session.sessionId) throw new AcpSessionError(t("Codex ACP \u6C92\u6709\u5EFA\u7ACB session"));
    const sessionId = session.sessionId;
    (_a = this.acp) == null ? void 0 : _a.sessions.set(sessionId, { updates: [] });
    this.acpConfigIds = this.codexConfigIds(session.configOptions);
    const acpModels = this.codexModelsFromConfig(session.configOptions);
    if (acpModels.length) {
      const merged = Array.from(/* @__PURE__ */ new Set([...acpModels, ...this.settings.models.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)]));
      const next = merged.join(", ");
      if (next !== this.settings.models) {
        this.settings.models = next;
        await this.saveSettings();
      }
    }
    try {
      const modelOption = model.trim();
      if (modelOption) await this.acpRequest("session/set_config_option", { sessionId, configId: this.acpConfigIds.model, value: modelOption }).catch((error) => {
        throw error instanceof AcpTransportError ? error : new AcpModelError(error instanceof Error ? error.message : String(error));
      });
      const modeLine = prompt.includes("\u9019\u662F Synthesize \u6A21\u5F0F") ? "high" : "low";
      if (this.acpConfigIds.reasoning) await this.acpRequest("session/set_config_option", { sessionId, configId: this.acpConfigIds.reasoning, value: modeLine }).catch(() => void 0);
      const response = await this.acpRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
      if (response.usage) console.debug("Visual Agent Map ACP usage", { sessionId, usage: response.usage, estimated: false });
      else console.debug("Visual Agent Map ACP usage", { sessionId, estimatedInputTokens: estimateTokens(prompt), estimated: true });
      try {
        return this.parseAiResult(this.acpText(sessionId).trim(), "Codex ACP");
      } catch (error) {
        throw new AcpParseError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      (_b = this.acp) == null ? void 0 : _b.sessions.delete(sessionId);
    }
  }
  async askCodexExec(instructions, model, pluginDirectory, schemaPath) {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--output-schema",
      schemaPath,
      "-C",
      pluginDirectory
    ];
    if (model) args.push("--model", model);
    args.push("--config", `model_reasoning_effort=${this.settings.cliReasoning || "low"}`);
    args.push("-");
    return new Promise((resolve, reject) => {
      const child = (0, import_node_child_process.spawn)(this.settings.cliPath, args, {
        cwd: pluginDirectory,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.childProcesses.add(child);
      let stdout = "";
      let stderr = "";
      const outputLimit = 5 * 1024 * 1024;
      const timeout = window.setTimeout(() => {
        child.kill();
        reject(new Error(t("Codex CLI \u57F7\u884C\u8D85\u904E 15 \u5206\u9418")));
      }, 15 * 60 * 1e3);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > outputLimit) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > outputLimit) child.kill();
      });
      child.on("error", (error) => {
        window.clearTimeout(timeout);
        this.childProcesses.delete(child);
        reject(new Error(`\u7121\u6CD5\u555F\u52D5 Codex CLI\uFF1A${error.message}`));
      });
      child.on("close", (code) => {
        window.clearTimeout(timeout);
        this.childProcesses.delete(child);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Codex CLI \u7D50\u675F\u78BC\uFF1A${code != null ? code : "\u672A\u77E5"}`));
          return;
        }
        try {
          resolve(this.parseAiResult(stdout, "Codex CLI"));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stdin.end(instructions);
    });
  }
  async askClaude(context, model, pluginDirectory, schemaPath) {
    const schema = (0, import_node_fs.readFileSync)(schemaPath, "utf8");
    const args = [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--tools",
      "",
      "--no-session-persistence",
      "--json-schema",
      schema,
      "--model",
      model || "sonnet"
    ];
    const instructions = [
      "\u4F60\u662F\u8996\u89BA\u5316\u601D\u8003 Agent\u3002\u4E0D\u8981\u4FEE\u6539\u4EFB\u4F55\u6A94\u6848\uFF0C\u4E5F\u4E0D\u8981\u8B80\u53D6\u672C\u6A5F\u6A94\u6848\u3002",
      context.mode === "task" ? "\u9019\u662F\u4E00\u822C\u4EFB\u52D9\uFF1Asummary \u5FC5\u9808\u662F\u4E00\u53E5\u9069\u5408\u5FC3\u667A\u5716\u986F\u793A\u7684\u65B0\u76EE\u524D\u7406\u89E3\uFF0C80 \u5B57\u5167\uFF1Bdetail \u662F\u6703\u76F4\u63A5\u53D6\u4EE3\u820A Detail \u7684\u5B8C\u6574\u77E5\u8B58\u9801\uFF0C\u5FC5\u9808\u5438\u6536\u820A\u5167\u5BB9\u8207\u672C\u6B21\u767C\u73FE\u3001\u53BB\u9664\u91CD\u8907\u3001\u4FDD\u7559\u4ECD\u6709\u6548\u7684\u4F86\u6E90\u3002" : context.mode === "decompose" ? "\u9019\u662F Decompose \u6A21\u5F0F\uFF1A\u53EA\u7522\u751F 3\u20137 \u500B\u53EF\u7368\u7ACB\u8655\u7406\u7684\u5B50\u8B70\u984C suggestions\u3002summary \u8207 detail \u7C21\u8FF0\u62C6\u89E3\u5224\u65B7\uFF1B\u4E0D\u8981\u66F4\u65B0\u7D50\u8AD6\u3002" : context.mode === "synthesize" ? "\u9019\u662F Synthesize \u6A21\u5F0F\uFF1Asummary \u5FC5\u9808\u662F\u9AD8\u54C1\u8CEA\u6574\u5408\u7D50\u8AD6\uFF0C80 \u5B57\u5167\uFF1Bdetail \u5FC5\u9808\u6574\u5408\u4F86\u6E90\u5B8C\u6574\u77E5\u8B58\u3001\u6536\u6582\u91CD\u8907\u5167\u5BB9\u3001\u6E05\u695A\u5448\u73FE\u5171\u8B58\u3001\u5206\u6B67\u3001\u53D6\u6368\u8207\u672A\u89E3\u554F\u984C\uFF1B\u5B8C\u6210\u5F8C\u6703\u76F4\u63A5\u5BEB\u56DE\u3002" : "summary \u5FC5\u9808\u662F\u4E00\u53E5\u9069\u5408\u5FC3\u667A\u5716\u986F\u793A\u7684\u65B0\u76EE\u524D\u7406\u89E3\uFF0Cdetail \u5FC5\u9808\u662F\u5B8C\u6574\u7E41\u9AD4\u4E2D\u6587 Markdown \u5206\u6790\u3002",
      context.mode !== "decompose" ? "detail \u5FC5\u9808\u4E14\u53EA\u80FD\u4F9D\u5E8F\u4F7F\u7528\u4EE5\u4E0B\u516D\u500B\u4E09\u7D1A\u6A19\u984C\uFF1A### \u6838\u5FC3\u7D50\u8AD6\u3001### \u95DC\u9375\u77E5\u8B58\u3001### \u8B49\u64DA\u8207\u4F86\u6E90\u3001### \u53D6\u6368\u8207\u9650\u5236\u3001### \u5F85\u78BA\u8A8D\u4E8B\u9805\u3001### \u66F4\u65B0\u7D00\u9304\u3002\u66F4\u65B0\u7D00\u9304\u53EA\u65B0\u589E\u4E00\u884C\u672C\u6B21\u8B8A\u66F4\u6458\u8981\uFF0C\u4E0D\u53EF\u91CD\u8CBC\u5B8C\u6574\u7B54\u6848\uFF1B\u6C92\u6709\u5167\u5BB9\u7684\u6BB5\u843D\u5BEB\u300C\u5C1A\u5F85\u88DC\u5145\u300D\u3002" : "",
      context.mode !== "decompose" ? "\u82E5\u4EFB\u52D9\u9700\u8981\u8996\u89BA\u7406\u89E3\uFF08\u4F8B\u5982\u7A7F\u642D\u3001\u914D\u8272\u3001\u5BA4\u5167\u8A2D\u8A08\u3001\u98DF\u8B5C\u5916\u89C0\u3001UI \u53C3\u8003\uFF09\uFF0C\u8ACB\u63D0\u4F9B 1\u20136 \u500B\u5DF2\u641C\u5C0B\u5230\u7684\u5716\u7247\u53C3\u8003 visualReferences\uFF1B\u5FC5\u9808\u5305\u542B\u5716\u7247 URL \u8207\u4F86\u6E90\u9801 URL\uFF0C\u4E0D\u8981\u751F\u6210\u5716\u7247\uFF0C\u4E0D\u8981\u7DE8\u9020\u4F86\u6E90\u3002" : "",
      context.mode !== "decompose" ? "\u5716\u7247\u5FC5\u9808\u76F4\u63A5\u5D4C\u5165 detail \u7684\u76F8\u95DC\u8AAA\u660E\u6BB5\u843D\u4E4B\u5F8C\uFF0C\u4F7F\u7528 Markdown \u5716\u7247\u8A9E\u6CD5\uFF0C\u4E26\u5728\u5716\u7247\u4E0B\u65B9\u9644\u4F86\u6E90\u9801\u9023\u7D50\u3002\u4E0D\u8981\u5EFA\u7ACB\u8996\u89BA\u53C3\u8003\u3001\u5716\u793A\u6216\u5716\u7247\u96C6\u5408\u7684\u7368\u7ACB\u6BB5\u843D\uFF1B\u5716\u7247\u8207 visualReferences \u4F7F\u7528\u76F8\u540C URL\u3002\u512A\u5148\u641C\u5C0B\u53EF\u5E6B\u52A9\u7406\u89E3\u8B70\u984C\u7684\u76F8\u95DC\u5716\u7247\uFF0C\u627E\u4E0D\u5230\u53EF\u9760\u5716\u7247\u6642\u4E0D\u8981\u7DE8\u9020\u3002" : "",
      `\u76EE\u524D\u8B70\u984C\uFF1A
${context.title}`,
      `\u76EE\u524D\u7406\u89E3\uFF1A
${context.summary}`,
      context.mode !== "decompose" ? `\u73FE\u6709 Detail\uFF08\u9808\u6574\u5408\u5F8C\u5B8C\u6574\u53D6\u4EE3\uFF0C\u4E0D\u80FD\u539F\u6A23\u91CD\u8907\u8FFD\u52A0\uFF09\uFF1A
${context.detail || "\uFF08\u7121\uFF09"}` : "",
      `\u76EE\u524D\u8B70\u984C\u7684 AI \u898F\u5247\uFF08\u512A\u5148\u9075\u5B88\uFF09\uFF1A
${context.rules || "\uFF08\u7121\uFF09"}`,
      context.workingFindings ? `\u820A\u7248\u5F85\u6574\u7406\u767C\u73FE\uFF08\u672C\u6B21\u5FC5\u9808\u4E00\u4F75\u6536\u6582\uFF09\uFF1A
${context.workingFindings}` : "",
      context.sourceContext ? `\u6574\u5408\u4F86\u6E90\u80CC\u666F\uFF1A
${context.sourceContext}` : "",
      `\u7956\u5148\u8B70\u984C\u80CC\u666F\uFF1A
${context.ancestors || "\uFF08\u7121\uFF09"}`,
      `\u76EE\u524D\u4EFB\u52D9\uFF1A
${context.task}`
    ].join("\n\n");
    return new Promise((resolve, reject) => {
      const child = (0, import_node_child_process.spawn)(this.settings.claudePath, args, {
        cwd: pluginDirectory,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.childProcesses.add(child);
      let stdout = "";
      let stderr = "";
      const outputLimit = 5 * 1024 * 1024;
      const timeout = window.setTimeout(() => {
        child.kill();
        reject(new Error(t("Claude Code CLI \u57F7\u884C\u8D85\u904E 15 \u5206\u9418")));
      }, 15 * 60 * 1e3);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > outputLimit) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > outputLimit) child.kill();
      });
      child.on("error", (error) => {
        window.clearTimeout(timeout);
        this.childProcesses.delete(child);
        reject(new Error(`\u7121\u6CD5\u555F\u52D5 Claude Code CLI\uFF1A${error.message}`));
      });
      child.on("close", (code) => {
        window.clearTimeout(timeout);
        this.childProcesses.delete(child);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Claude Code CLI \u7D50\u675F\u78BC\uFF1A${code != null ? code : "\u672A\u77E5"}`));
          return;
        }
        try {
          const wrapper = JSON.parse(stdout.trim());
          if (wrapper.is_error) throw new Error(typeof wrapper.result === "string" ? wrapper.result : t("Claude Code CLI \u56DE\u50B3\u932F\u8AA4"));
          const raw = typeof wrapper.result === "string" ? wrapper.result.trim() : stdout.trim();
          resolve(this.parseAiResult(raw, "Claude"));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stdin.end(instructions);
    });
  }
};
