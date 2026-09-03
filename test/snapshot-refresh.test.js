import test from 'node:test'
import assert from 'node:assert/strict'
import Camera from '../devices/camera.js'

function makeSnapshot(contents, timeMillis) {
    const snapshot = Buffer.from(contents)
    snapshot.timeMillis = timeMillis
    return snapshot
}

function makeCamera(responses) {
    const camera = Object.create(Camera.prototype)
    const previousSnapshot = makeSnapshot('previous', 100)

    camera.data = {
        snapshot: {
            cache: previousSnapshot,
            cacheType: 'motion',
            sourceTimestamp: 100,
            timestamp: 1
        }
    }
    camera.snapshotRefreshGeneration = 0
    camera.debugMessages = []
    camera.publishCount = 0
    camera.debug = message => camera.debugMessages.push(String(message))
    camera.publishSnapshot = () => camera.publishCount++
    camera.device = {
        snapshotsAreBlocked: false,
        operatingOnBattery: false,
        getNextSnapshot: async options => {
            camera.lastRequestOptions = options
            camera.requestCount = (camera.requestCount || 0) + 1
            const response = responses.shift()
            return typeof response === 'function' ? response(options) : response
        }
    }

    return camera
}

test('on-demand snapshot rejects an exact duplicate and publishes the next distinct frame', async () => {
    const camera = makeCamera([
        makeSnapshot('previous', 100),
        makeSnapshot('new frame', 101)
    ])

    const result = await camera.refreshSnapshot('on-demand')

    assert.equal(result, true)
    assert.equal(camera.requestCount, 2)
    assert.equal(camera.publishCount, 1)
    assert.equal(camera.data.snapshot.cache.toString(), 'new frame')
    assert.equal(camera.data.snapshot.sourceTimestamp, 101)
    assert.deepEqual(camera.lastRequestOptions, {
        afterMs: 100,
        maxWaitMs: 3000,
        force: true
    })
    assert.ok(camera.debugMessages.some(message => message.includes('Discarding duplicate')))
})

test('on-demand snapshot never publishes when Ring returns only duplicates', async () => {
    const camera = makeCamera([
        makeSnapshot('previous', 100),
        makeSnapshot('previous', 100),
        makeSnapshot('previous', 100)
    ])

    const result = await camera.refreshSnapshot('on-demand')

    assert.equal(result, false)
    assert.equal(camera.requestCount, 3)
    assert.equal(camera.publishCount, 0)
    assert.equal(camera.data.snapshot.cache.toString(), 'previous')
})

test('on-demand snapshot rejects a changed buffer with a stale Ring timestamp', async () => {
    const camera = makeCamera([
        makeSnapshot('different but stale', 100),
        makeSnapshot('different and new', 101)
    ])

    const result = await camera.refreshSnapshot('on-demand')

    assert.equal(result, true)
    assert.equal(camera.requestCount, 2)
    assert.equal(camera.publishCount, 1)
    assert.equal(camera.data.snapshot.cache.toString(), 'different and new')
    assert.ok(camera.debugMessages.some(message => message.includes('Discarding stale')))
})

test('a delayed request cannot overwrite a newer motion snapshot', async () => {
    let resolveOnDemand
    const camera = makeCamera([])

    camera.device.getNextSnapshot = options => {
        if (options.afterMs) {
            return new Promise(resolve => {
                resolveOnDemand = resolve
            })
        }
        return Promise.resolve(makeSnapshot('new motion', 200))
    }

    const delayedOnDemand = camera.refreshSnapshot('on-demand')
    await new Promise(resolve => setImmediate(resolve))
    const motionResult = await camera.refreshSnapshot('motion', 'motion-uuid')
    resolveOnDemand(makeSnapshot('late on-demand', 201))
    const onDemandResult = await delayedOnDemand

    assert.equal(motionResult, true)
    assert.equal(onDemandResult, false)
    assert.equal(camera.publishCount, 1)
    assert.equal(camera.data.snapshot.cache.toString(), 'new motion')
    assert.equal(camera.data.snapshot.cacheType, 'motion')
    assert.ok(camera.debugMessages.some(message => message.includes('Discarding superseded')))
})

test('interval refresh keeps publishing even when the scene bytes are unchanged', async () => {
    const camera = makeCamera([makeSnapshot('previous', 101)])

    const result = await camera.refreshSnapshot('interval')

    assert.equal(result, true)
    assert.equal(camera.publishCount, 1)
    assert.equal(camera.data.snapshot.cacheType, 'interval')
})
