/**
 * Kafka connector — write-only sink that publishes records as JSON messages.
 *
 * Design decisions:
 * - This is a write-only connector. Kafka topics are an append-only log; there is
 *   no meaningful "read current state" operation the engine can use for syncing,
 *   so fetch() and lookup() are omitted. The entity is a pure sink.
 * - One connector instance = one topic. Use multiple instances for multiple topics.
 * - Each message is keyed by the record ID (for partition affinity and compaction).
 * - insert() and update() both produce messages (upsert semantics for downstream consumers).
 * - delete() produces a tombstone message (null value) — the standard Kafka compaction signal.
 * - Messages carry an opensync_op header ('insert' | 'update' | 'delete') for consumers
 *   that want to distinguish the operation type.
 *
 * Auth: SASL/PLAIN or SASL/SCRAM via config. TLS always enabled in production.
 */
import { Kafka, type Producer, CompressionTypes, type KafkaConfig } from "kafkajs";
import type {
  Connector,
  ConnectorContext,
  EntityDefinition,
  InsertRecord,
  InsertResult,
  UpdateRecord,
  UpdateResult,
  DeleteResult,
} from "@opensync/sdk";
import { ConnectorError } from "@opensync/sdk";

// ─── Producer management ──────────────────────────────────────────────────────

const producers = new Map<string, Producer>();

function clientId(ctx: ConnectorContext): string {
  return (ctx.config["clientId"] as string | undefined) ?? "opensync";
}

function topicName(ctx: ConnectorContext): string {
  const t = ctx.config["topic"];
  if (typeof t !== "string" || !t) {
    throw new ConnectorError("config.topic must be a non-empty string", "CONFIG_ERROR", false);
  }
  return t;
}

function brokers(ctx: ConnectorContext): string[] {
  const b = ctx.config["brokers"];
  if (typeof b === "string") return b.split(",").map((s) => s.trim());
  if (Array.isArray(b)) return b as string[];
  throw new ConnectorError(
    "config.brokers must be a comma-separated string or array",
    "CONFIG_ERROR",
    false
  );
}

function buildKafkaConfig(ctx: ConnectorContext): KafkaConfig {
  const cfg: KafkaConfig = {
    clientId: clientId(ctx),
    brokers: brokers(ctx),
  };

  const saslMechanism = ctx.config["saslMechanism"] as string | undefined;
  const saslUsername = ctx.config["saslUsername"] as string | undefined;
  const saslPassword = ctx.config["saslPassword"] as string | undefined;

  if (saslMechanism && saslUsername && saslPassword) {
    if (saslMechanism === "plain") {
      cfg.ssl = true;
      cfg.sasl = { mechanism: "plain", username: saslUsername, password: saslPassword };
    } else if (saslMechanism === "scram-sha-256") {
      cfg.ssl = true;
      cfg.sasl = { mechanism: "scram-sha-256", username: saslUsername, password: saslPassword };
    } else if (saslMechanism === "scram-sha-512") {
      cfg.ssl = true;
      cfg.sasl = { mechanism: "scram-sha-512", username: saslUsername, password: saslPassword };
    } else {
      throw new ConnectorError(
        `Unsupported SASL mechanism: '${saslMechanism}'. Use plain, scram-sha-256, or scram-sha-512.`,
        "CONFIG_ERROR",
        false
      );
    }
  }

  return cfg;
}

async function getProducer(ctx: ConnectorContext): Promise<Producer> {
  const key = `${brokers(ctx).join(",")}/${topicName(ctx)}`;
  if (!producers.has(key)) {
    const kafka = new Kafka(buildKafkaConfig(ctx));
    const producer = kafka.producer();
    await producer.connect();
    producers.set(key, producer);
  }
  return producers.get(key)!;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collect an async iterable into fixed-size arrays. */
async function* chunk<T>(
  source: AsyncIterable<T>,
  size: number
): AsyncIterable<T[]> {
  let batch: T[] = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

// ─── Entity ───────────────────────────────────────────────────────────────────

const messageEntity: EntityDefinition = {
  name: "message",

  schema: {
    // No fixed schema — the message payload is whatever the source entity emits.
  },

  // No fetch() — Kafka is an append-only write-only sink from the engine's perspective.
  // The engine will never poll this entity for changes.

  async *insert(
    records: AsyncIterable<InsertRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<InsertResult> {
    const producer = await getProducer(ctx);
    const topic = topicName(ctx);

    for await (const batch of chunk(records, 100)) {
      const messages = batch.map((record) => {
        const id = record.data["id"] as string | undefined ?? crypto.randomUUID();
        return {
          key: id,
          value: JSON.stringify(record.data),
          headers: { opensync_op: "insert" },
        };
      });

      try {
        await producer.send({
          topic,
          messages,
          compression: CompressionTypes.GZIP,
        });
      } catch (err) {
        throw new ConnectorError(
          `Kafka produce failed: ${(err as Error).message}`,
          "PRODUCE_ERROR",
          true
        );
      }

      for (const msg of messages) {
        yield { id: msg.key };
      }
    }
  },

  async *update(
    records: AsyncIterable<UpdateRecord>,
    ctx: ConnectorContext
  ): AsyncIterable<UpdateResult> {
    const producer = await getProducer(ctx);
    const topic = topicName(ctx);

    for await (const batch of chunk(records, 100)) {
      const messages = batch.map((record) => ({
        key: record.id,
        value: JSON.stringify({ id: record.id, ...record.data }),
        headers: { opensync_op: "update" },
      }));

      try {
        await producer.send({
          topic,
          messages,
          compression: CompressionTypes.GZIP,
        });
      } catch (err) {
        throw new ConnectorError(
          `Kafka produce failed: ${(err as Error).message}`,
          "PRODUCE_ERROR",
          true
        );
      }

      for (const record of batch) {
        yield { id: record.id };
      }
    }
  },

  async *delete(
    ids: AsyncIterable<string>,
    ctx: ConnectorContext
  ): AsyncIterable<DeleteResult> {
    const producer = await getProducer(ctx);
    const topic = topicName(ctx);

    for await (const batch of chunk(ids, 100)) {
      // Tombstone: null value signals log-compacted deletion to consumers.
      const messages = batch.map((id) => ({
        key: id,
        value: null, // tombstone
        headers: { opensync_op: "delete" },
      }));

      try {
        await producer.send({ topic, messages });
      } catch (err) {
        throw new ConnectorError(
          `Kafka tombstone produce failed: ${(err as Error).message}`,
          "PRODUCE_ERROR",
          true
        );
      }

      for (const id of batch) {
        yield { id };
      }
    }
  },
};

// ─── Connector ────────────────────────────────────────────────────────────────

const connector: Connector = {
  metadata: {
    name: "kafka",
    version: "0.1.0",
    auth: { type: "none" }, // SASL credentials go through configSchema (secret fields)
    configSchema: {
      brokers: {
        type: "string",
        description: "Comma-separated list of Kafka broker addresses (host:port).",
        required: true,
      },
      topic: {
        type: "string",
        description: "Topic to publish messages to.",
        required: true,
      },
      clientId: {
        type: "string",
        description: "Kafka client ID shown in broker logs. Defaults to 'opensync'.",
        required: false,
        default: "opensync",
      },
      saslMechanism: {
        type: "string",
        description:
          "SASL mechanism for authentication. One of: plain, scram-sha-256, scram-sha-512. Leave empty for unauthenticated (dev clusters).",
        required: false,
      },
      saslUsername: {
        type: "string",
        description: "SASL username.",
        required: false,
        secret: true,
      },
      saslPassword: {
        type: "string",
        description: "SASL password.",
        required: false,
        secret: true,
      },
    },
  },

  getEntities(): EntityDefinition[] {
    return [messageEntity];
  },

  async onDisable(ctx) {
    const key = `${brokers(ctx).join(",")}/${topicName(ctx)}`;
    if (producers.has(key)) {
      await producers.get(key)!.disconnect();
      producers.delete(key);
    }
  },

  async healthCheck(ctx) {
    try {
      const producer = await getProducer(ctx);
      // If we got a connected producer, the cluster is reachable.
      void producer;
      return { healthy: true };
    } catch (err) {
      return {
        healthy: false,
        message: `Kafka connection failed: ${(err as Error).message}`,
      };
    }
  },
};

export default connector;
