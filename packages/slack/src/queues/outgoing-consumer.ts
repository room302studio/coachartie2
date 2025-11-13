// Outgoing message consumer for Slack
// This file exists to match Discord's architecture pattern
// The actual consumer logic is in consumer.ts
// This file is imported by index.ts to start the consumer

import { logger } from '@coachartie/shared';

logger.info('Slack outgoing-consumer module loaded');

// Consumer is started via startResponseConsumer() in index.ts
// This module can be extended for additional outgoing message processing if needed
