import type { GraphInput, JsonObject, NodeTypeDefinition, WorkflowDocument } from '../contracts'
import { nodeDefinition } from './workflow-utils'

export type InputFile = { input: GraphInput; file: File }
export function acceptsInputMime(input: GraphInput, file: File) {
  return !file.type || !input.acceptedMimeTypes.length || input.acceptedMimeTypes.some((mime) => mime === '*/*' || mime === file.type || (mime.endsWith('/*') && file.type.startsWith(mime.slice(0, -1))))
}
export function compatibleInputFiles(previous: InputFile[], inputs: GraphInput[]): Record<string, File> {
  const available = [...previous], result: Record<string, File> = {}
  for (const exact of [true, false]) {
    for (const input of inputs.filter((item) => !result[item.id])) {
      const index = available.findIndex((entry) => (!exact || entry.input.id === input.id) && entry.input.schemaId === input.schemaId && acceptsInputMime(input, entry.file))
      if (index >= 0) result[input.id] = available.splice(index, 1)[0].file
    }
  }
  return result
}
function downloadForInput(document: WorkflowDocument, types: NodeTypeDefinition[], input: GraphInput) {
  const isSource = (source: { nodeId: string; portId: string }) => source.nodeId === '$inputs' && source.portId === input.id
  const consumers = document.edges.filter((edge) => isSource(edge.source)).map(({ target }) => {
    const node = document.nodes.find((item) => item.id === target.nodeId)
    return node && nodeDefinition(node, types)?.inputs.find((port) => port.id === target.portId)
  })
  const graphOutputs = document.outputs.filter((port) => isSource(port.source))
  const downloads = types.filter((type) => type.inputs.length === 0 && (
    type.runtimeInputSchema?.required?.includes('url') || type.operation === 'download' ||
    type.type === 'youdub.download' || type.operation?.endsWith('.download/v1')
  ))
  const candidates = downloads.flatMap((definition) => definition.outputs
    .filter((port) => port.kind === 'artifact' &&
      consumers.every((target) => target?.kind === 'artifact' && target.acceptedSchemaIds.includes(port.schemaId)) &&
      graphOutputs.every((target) => target.schemaId === port.schemaId))
    .map((output) => ({ definition, output })))
  const exact = candidates.find(({ output }) => output.schemaId === input.schemaId)
  if (exact || input.schemaId !== 'file/v1') return exact
  return candidates.find(({ output }) => {
    const prefix = output.schemaId.split('/')[0] + '/'
    return !input.acceptedMimeTypes.length || input.acceptedMimeTypes.some((mime) => mime === '*/*' || mime.startsWith(prefix))
  })
}
export function videoLinkInput(document: WorkflowDocument, types: NodeTypeDefinition[]) {
  const mediaInputs = document.inputs.filter((input) => input.acceptedMimeTypes.some((mime) => mime.startsWith('video/') || mime.startsWith('audio/')))
  const input = mediaInputs.length === 1 ? mediaInputs[0] : undefined
  return input && downloadForInput(document, types, input) ? input : undefined
}
export function withVideoLink(document: WorkflowDocument, types: NodeTypeDefinition[], inputId: string, url: string, proxyPort: number): { document: WorkflowDocument; runtime: Record<string, JsonObject> } {
  const input = document.inputs.find((item) => item.id === inputId)
  const { definition, output } = input && downloadForInput(document, types, input) || {}
  if (!input || !definition || !output) throw new Error('The workflow cannot import this media link.')
  let id = 'source-download'
  while (document.nodes.some((node) => node.id === id)) id += '-1'
  const source = (endpoint: { nodeId: string; portId: string }) => endpoint.nodeId === '$inputs' && endpoint.portId === inputId ? { nodeId: id, portId: output.name } : endpoint
  return {
    document: {
      ...document, inputs: document.inputs.filter((item) => item.id !== inputId),
      nodes: [{ id, type: definition.type, typeVersion: definition.version, provider: { id: definition.providerId }, config: { ...structuredClone(definition.defaults), proxyPort }, autoContinue: true }, ...document.nodes],
      edges: document.edges.map((edge) => ({ ...edge, source: source(edge.source) })),
      outputs: document.outputs.map((item) => ({ ...item, source: source(item.source) })),
      presentation: { ...document.presentation, positions: { ...document.presentation.positions, [id]: { x: 0, y: 0 } } },
    }, runtime: { [id]: { url } },
  }
}
