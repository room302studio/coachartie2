import { Router, Request, Response } from 'express';
import { logger, isOwner, GenerationMutedError } from '@coachartie/shared';
import { stackTalk } from '../services/stack-talk/stack-talk.js';

/**
 * POST /stack-talk { question, askedBy, scope?: { userId?, guildId? }, deep? }
 * Owner-only: the answer can quote anyone's memories. The capabilities service listens on
 * 127.0.0.1 only; askedBy is checked as defense in depth. See services/stack-talk.
 */
const router: Router = Router();

router.post('/', async (req: Request, res: Response) => {
  const { question, askedBy, scope, deep } = req.body ?? {};
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ success: false, error: 'question is required' });
  }
  if (typeof askedBy !== 'string' || !isOwner(askedBy)) {
    return res.status(403).json({ success: false, error: 'stack-talk is owner-only' });
  }

  const started = Date.now();
  try {
    const result = await stackTalk({
      question,
      askedBy,
      deep: deep === true,
      scope: {
        userId: typeof scope?.userId === 'string' ? scope.userId : undefined,
        guildId: typeof scope?.guildId === 'string' ? scope.guildId : undefined,
      },
    });
    return res.json({ success: true, ...result, ms: Date.now() - started });
  } catch (error) {
    const muted = error instanceof GenerationMutedError;
    logger.warn(`📚 stack-talk failed${muted ? ' (muted)' : ''}:`, error);
    return res.status(muted ? 503 : 500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export { router as stackTalkRouter };
