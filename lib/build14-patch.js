import './build12-patch.js'
import Camera from '../devices/camera.js'

const build13InitAttributeEntities = Camera.prototype.initAttributeEntities
const build13PublishDiscovery = Camera.prototype.publishDiscovery
const build13PublishState = Camera.prototype.publishState
const wrappedControllers = new WeakSet()

export function removeBrokenStillImageUrl(camera) {
    if (camera?.data?.stream?.live) {
        // MQTT sensor attributes are plain JSON; Home Assistant does not render
        // Jinja embedded in still_Image_URL. Missing/undefined is intentionally
        // omitted by JSON.stringify in Camera.publishAttributes().
        delete camera.data.stream.live.stillImageURL
    }
}

function extractBuild14Diagnostics(details = {}) {
    return {
        selectionMode: details.selectionMode || 'adaptive',
        candidateFramesEvaluated: Number.isInteger(details.candidateFramesEvaluated) ? details.candidateFramesEvaluated : 0,
        actualFrameOffsetsMs: Array.isArray(details.actualFrameOffsetsMs) ? details.actualFrameOffsetsMs : (Array.isArray(details.frameOffsetsMs) ? details.frameOffsetsMs : []),
        differenceScores: Array.isArray(details.differenceScores) ? details.differenceScores : [],
        changedBlockRatios: Array.isArray(details.changedBlockRatios) ? details.changedBlockRatios : [],
        selectionReasons: Array.isArray(details.selectionReasons) ? details.selectionReasons : [],
        selectionThreshold: Number.isFinite(details.selectionThreshold) ? details.selectionThreshold : null,
        minimumSelectionSeparationMs: Number.isFinite(details.minimumSelectionSeparationMs) ? details.minimumSelectionSeparationMs : null,
        framePts: Array.isArray(details.framePts) ? details.framePts : [],
        framePtsTime: Array.isArray(details.framePtsTime) ? details.framePtsTime : [],
        frameTimestamps: Array.isArray(details.frameTimestamps) ? details.frameTimestamps : [],
        frameTypes: Array.isArray(details.frameTypes) ? details.frameTypes : [],
        frameRawChecksums: Array.isArray(details.frameRawChecksums) ? details.frameRawChecksums : [],
        frameHashes: Array.isArray(details.frameHashes) ? details.frameHashes : [],
        rtpIntegrity: details.rtpIntegrity && typeof details.rtpIntegrity === 'object' ? details.rtpIntegrity : {}
    }
}

function publishBuild14BurstDiagnostics(camera, details) {
    const entity = camera.entity?.ki_burst_status
    if (!entity?.json_attributes_topic || !camera.data?.ki_burst?.attributes) return

    const diagnostics = extractBuild14Diagnostics(details)
    camera.data.ki_burst.build14Diagnostics = diagnostics
    const attributes = {
        ...camera.data.ki_burst.attributes,
        ...diagnostics
    }

    camera.data.ki_burst.attributes = attributes
    camera.mqttPublish(entity.json_attributes_topic, JSON.stringify(attributes), 'attr')
}

function republishStoredBuild14Diagnostics(camera) {
    const diagnostics = camera.data?.ki_burst?.build14Diagnostics
    const entity = camera.entity?.ki_burst_status
    if (!diagnostics || !entity?.json_attributes_topic || !camera.data?.ki_burst?.attributes) return

    const attributes = {
        ...camera.data.ki_burst.attributes,
        ...diagnostics
    }
    camera.data.ki_burst.attributes = attributes
    camera.mqttPublish(entity.json_attributes_topic, JSON.stringify(attributes), 'attr')
}

function attachBuild14ControllerDiagnostics(camera) {
    const controller = camera?.kiBurstController
    if (!controller || wrappedControllers.has(controller)) return

    const build13OnState = controller.onState
    controller.onState = (status, details = {}) => {
        build13OnState(status, details)
        if (status === 'complete') publishBuild14BurstDiagnostics(camera, details)
        if (status === 'capturing' || status === 'failed') delete camera.data?.ki_burst?.build14Diagnostics
    }
    wrappedControllers.add(controller)
}

Camera.prototype.initAttributeEntities = async function(...args) {
    const result = await build13InitAttributeEntities.apply(this, args)
    removeBrokenStillImageUrl(this)
    return result
}

Camera.prototype.publishDiscovery = async function(...args) {
    const result = await build13PublishDiscovery.apply(this, args)
    attachBuild14ControllerDiagnostics(this)
    return result
}

Camera.prototype.publishState = async function(...args) {
    const result = await build13PublishState.apply(this, args)
    attachBuild14ControllerDiagnostics(this)
    if (this.data?.ki_burst?.status === 'complete') republishStoredBuild14Diagnostics(this)
    return result
}
