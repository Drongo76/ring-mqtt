export async function captureBurstWithCleanup({ session, burstId, options = {}, onCleanup = () => {} }) {
    let result = null
    let failure = null

    try {
        result = await session.captureJpegBurst({ burstId, ...options })
    } catch (error) {
        failure = error
    } finally {
        try {
            session.stop()
        } catch (error) {
            if (!failure) failure = error
        }
        onCleanup({ burstId, failure })
    }

    return { result, failure }
}
