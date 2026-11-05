import { describe, expect, it, afterAll } from "vitest";
import { createIaFactoryImplementation } from "./provider.js";
import { docker } from "./docker-cli.js";
import { MANAGED_LABEL, sandboxIdFor } from "./labels.js";
import { sweep } from "./janitor.js";
import { readScope } from "./registry.js";

/**
 * The provider talks to a real Docker daemon.
 *
 * @remarks
 * The Docker plumbing is the part of the factory that cannot be checked by
 * reading it: a container that does not start, a volume that does not
 * mount, a stream that never ends. These tests run against the local
 * daemon and clean up after themselves.
 *
 * They are skipped when Docker is not reachable, so the suite still passes
 * on a machine without it.
 */

/**
 * The root of a dispatch chain.
 *
 * @remarks
 * Every station of a task is a descendant of the session the developer
 * talks to, and eve populates `parent.rootSessionId` at dispatch. That is
 * how two stations find the same shared checkout without passing anything
 * around.
 */
const ROOT_SESSION_ID = `test-root-${Date.now()}`;
const SESSION_ID = `test-session-${Date.now()}`;
/** A second station of the same task: it must see the first one's work. */
const SESSION_ID_2 = `test-session-2-${Date.now()}`;
/** The stations of the shared-volume test, separate from the first test. */
const SHARED_SESSION_ID = `test-shared-${Date.now()}`;
const SHARED_SESSION_ID_2 = `test-shared-2-${Date.now()}`;

async function dockerAvailable(): Promise<boolean> {
  const result = await docker(["info", "--format", "{{.ServerVersion}}"]);
  return result.exitCode === 0;
}

const dockerOk = await dockerAvailable();
const suite = dockerOk ? describe : describe.skip;

suite("the Docker sandbox provider", () => {
  const containerName = sandboxIdFor(SESSION_ID);

  afterAll(async () => {
    await docker(["rm", "-f", containerName]);
    await docker(["rm", "-f", sandboxIdFor(SESSION_ID_2)]);
    await docker(["rm", "-f", sandboxIdFor(SHARED_SESSION_ID)]);
    await docker(["rm", "-f", sandboxIdFor(SHARED_SESSION_ID_2)]);
    await sweep({ ttlMinutes: 0 });
    // The tests build their own template images; they are not reusable.
    const images = await docker([
      "images",
      "-q",
      "--filter",
      "reference=iaf-tpl-test-*",
    ]);
    for (const image of images.stdout.split("\n").filter((line) => line.trim() !== "")) {
      await docker(["image", "rm", "-f", image.trim()]);
    }
  });

  it("starts a labelled container that runs commands", async () => {
    const environment = createIaFactoryImplementation({
      role: "builder",
      volumeMode: "rw",
    });

    const artifact = await environment.prepare({
      isEmpty: true,
      storagePath: "/tmp/ia-factory-test",
      files: {
        list: async () => [],
        read: async () => new Uint8Array(),
        readText: async () => "",
      },
      log: () => undefined,
      populate: async () => undefined,
      resolveProjectPath: (path: string) => path,
      resourcesDirectory: async () => undefined,
      templateKey: (identity: unknown) =>
        `test-${JSON.stringify(identity).length}-${Date.now()}`,
    } as never);

    const { connection, state } = await environment.start(
      {
        session: { id: SESSION_ID, parent: { rootSessionId: ROOT_SESSION_ID } },
        kind: "session",
        storagePath: "/tmp/ia-factory-test",
        resolveProjectPath: (path: string) => path,
      } as never,
      undefined,
      artifact,
    );

    expect(state.containerName).toBe(containerName);

    // The container carries the factory labels, so the janitor can find it.
    const inspected = await docker([
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      containerName,
    ]);
    expect(inspected.exitCode).toBe(0);
    const labels = JSON.parse(inspected.stdout.trim()) as Record<string, string>;
    expect(labels[MANAGED_LABEL]).toBe("true");
    expect(labels["ia-factory.scope-id"]).toBe(ROOT_SESSION_ID);

    // Commands run, and their output comes back.
    const run = await connection.spawn({
      command: "echo hello-from-the-sandbox",
      env: {},
      workingDirectory: "/workspace",
    });
    const stdout = await new Response(run.stdout).text();
    const exit = await run.wait();
    expect(stdout.trim()).toBe("hello-from-the-sandbox");
    expect(exit.exitCode).toBe(0);

    // Files round-trip through the container.
    await connection.writeFiles({
      files: [
        {
          path: "/workspace/probe.txt",
          content: new TextEncoder().encode("contenido"),
        },
      ],
    });
    const read = await connection.readFile({ path: "/workspace/probe.txt" });
    expect(read).not.toBeNull();
    expect(new TextDecoder().decode(read as Uint8Array)).toBe("contenido");

    // A missing file is null, not an error.
    expect(await connection.readFile({ path: "/workspace/missing.txt" })).toBeNull();

    await connection.removePath({ path: "/workspace/probe.txt" });
    expect(await connection.readFile({ path: "/workspace/probe.txt" })).toBeNull();

    // Cleanup removes the container and is safe to repeat.
    await environment.onSessionEnd(
      {
        session: { id: SESSION_ID, parent: { rootSessionId: ROOT_SESSION_ID } },
        kind: "session",
        storagePath: "/tmp/ia-factory-test",
        resolveProjectPath: (path: string) => path,
      } as never,
      state,
      { reason: "deleted" },
    );
    const gone = await docker([
      "container",
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]);
    expect(gone.exitCode).not.toBe(0);

    // The janitor never touches a container without the managed label.
    const foreign = await docker([
      "run",
      "-d",
      "--name",
      `iaf-foreign-${Date.now()}`,
      "--entrypoint",
      "/bin/sh",
      "alpine:3",
      "-c",
      "sleep 60",
    ]);
    if (foreign.exitCode === 0) {
      const report = await sweep({ ttlMinutes: 0 });
      expect(report.removedContainers).not.toContain(`iaf-foreign-${Date.now()}`);
      await docker(["rm", "-f", `iaf-foreign-${Date.now()}`]);
    }
  });
});

suite("the shared volume", () => {
  it("lets a second station of the same task see the first one's work", async () => {
    const implementation = createIaFactoryImplementation({
      role: "builder",
      volumeMode: "rw",
    });

    const artifact = await implementation.prepare({
      isEmpty: true,
      storagePath: "/tmp/ia-factory-test",
      files: {
        list: async () => [],
        read: async () => new Uint8Array(),
        readText: async () => "",
      },
      log: () => undefined,
      populate: async () => undefined,
      resolveProjectPath: (path: string) => path,
      resourcesDirectory: async () => undefined,
      templateKey: () => `test-shared-${Date.now()}`,
    } as never);

    const context = (sessionId: string, rootSessionId = ROOT_SESSION_ID) =>
      ({
        session: { id: sessionId, parent: { rootSessionId } },
        kind: "session",
        storagePath: "/tmp/ia-factory-test",
        resolveProjectPath: (path: string) => path,
      }) as never;

    // The builder writes into the shared volume.
    const builder = await implementation.start(
      context(SHARED_SESSION_ID),
      undefined,
      artifact,
    );
    await builder.connection.writeFiles({
      files: [
        {
          path: "/workspace/repo/shared.txt",
          content: new TextEncoder().encode("del builder"),
        },
      ],
    });

    // A second station of the same task mounts the same volume read-only.
    const analyser = createIaFactoryImplementation({
      role: "analyser",
      volumeMode: "ro",
    });
    const reader = await analyser.start(
      context(SHARED_SESSION_ID_2),
      undefined,
      artifact,
    );

    expect(reader.state.volumeName).toBe(builder.state.volumeName);

    const seen = await reader.connection.readFile({
      path: "/workspace/repo/shared.txt",
    });
    expect(seen).not.toBeNull();
    expect(new TextDecoder().decode(seen as Uint8Array)).toBe("del builder");

    // The read-only mount refuses a write: a reviewer cannot edit the diff.
    await expect(
      reader.connection.writeFiles({
        files: [
          {
            path: "/workspace/repo/shared.txt",
            content: new TextEncoder().encode("del analyst"),
          },
        ],
      }),
    ).rejects.toThrow();

    await implementation.onSessionEnd(context(SHARED_SESSION_ID), builder.state, {
      reason: "deleted",
    });
    await analyser.onSessionEnd(
      context(SHARED_SESSION_ID_2),
      reader.state,
      { reason: "deleted" },
    );

    // With every container gone, the janitor can take the volume too.
    await sweep({ ttlMinutes: 0 });
  });
});

suite("scope isolation", () => {
  it("gives two different tasks two different volumes", async () => {
    const implementation = createIaFactoryImplementation({
      role: "builder",
      volumeMode: "rw",
    });

    const artifact = await implementation.prepare({
      isEmpty: true,
      storagePath: "/tmp/ia-factory-test",
      files: {
        list: async () => [],
        read: async () => new Uint8Array(),
        readText: async () => "",
      },
      log: () => undefined,
      populate: async () => undefined,
      resolveProjectPath: (path: string) => path,
      resourcesDirectory: async () => undefined,
      templateKey: () => `test-isolation-${Date.now()}`,
    } as never);

    const context = (sessionId: string, rootSessionId: string) =>
      ({
        session: { id: sessionId, parent: { rootSessionId } },
        kind: "session",
        storagePath: "/tmp/ia-factory-test",
        resolveProjectPath: (path: string) => path,
      }) as never;

    const otherRoot = `test-root-other-${Date.now()}`;
    const otherSession = `test-session-other-${Date.now()}`;

    const first = await implementation.start(
      context(`test-session-a-${Date.now()}`, ROOT_SESSION_ID),
      undefined,
      artifact,
    );
    const second = await implementation.start(
      context(otherSession, otherRoot),
      undefined,
      artifact,
    );

    // Two tasks, two volumes: one task's checkout is never visible to another.
    expect(second.state.volumeName).not.toBe(first.state.volumeName);

    await implementation.onSessionEnd(
      context(`test-session-a-${Date.now()}`, ROOT_SESSION_ID),
      first.state,
      { reason: "deleted" },
    );
    await implementation.onSessionEnd(
      context(otherSession, otherRoot),
      second.state,
      { reason: "deleted" },
    );
    await sweep({ ttlMinutes: 0 });
  });
});

suite("the janitor", () => {
  it("takes the volume when the root session ends, without waiting for the TTL", async () => {
    const implementation = createIaFactoryImplementation({
      role: "builder",
      volumeMode: "rw",
    });

    const artifact = await implementation.prepare({
      isEmpty: true,
      storagePath: "/tmp/ia-factory-test",
      files: {
        list: async () => [],
        read: async () => new Uint8Array(),
        readText: async () => "",
      },
      log: () => undefined,
      populate: async () => undefined,
      resolveProjectPath: (path: string) => path,
      resourcesDirectory: async () => undefined,
      templateKey: () => `test-janitor-${Date.now()}`,
    } as never);

    // A root session: no parent. It is the task.
    const rootSessionId = `test-root-janitor-${Date.now()}`;
    const rootContext = {
      session: { id: rootSessionId },
      kind: "session",
      storagePath: "/tmp/ia-factory-test",
      resolveProjectPath: (path: string) => path,
    } as never;

    const root = await implementation.start(
      rootContext,
      undefined,
      artifact,
    );

    // The scope is alive: the janitor leaves it alone, whatever the TTL.
    expect(await readScope(rootSessionId)).not.toBeNull();
    expect((await readScope(rootSessionId))?.status).toBe("running");

    // The root session ends: the scope is over.
    await implementation.onSessionEnd(rootContext, root.state, {
      reason: "completed",
    });
    expect((await readScope(rootSessionId))?.status).toBe("completed");

    // And the volume goes with it, without waiting for the TTL.
    const volumes = await docker([
      "volume",
      "ls",
      "-q",
      "--filter",
      `name=${root.state.volumeName}`,
    ]);
    expect(volumes.stdout.trim()).toBe("");

    // The janitor agrees: the scope is over, so there is nothing left.
    const report = await sweep({ ttlMinutes: 60 });
    expect(report.failed).toEqual([]);
  });
});
