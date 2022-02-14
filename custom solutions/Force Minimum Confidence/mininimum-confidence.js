  async function hook() {
    if (event.nlu.intent.confidence < 0.75) {
      bp.logger.info("Confidence too low, overriding...")
      event.nlu.intent = {
        name: 'none',
        confidence: 1,
        context: 'global'
      }
    }
  }
  return hook()
