import Docker, { DockerOptions } from "dockerode";
import gunzip from "gunzip-maybe";
import os from "os";
import randomWords from "random-words";
import fs from "fs-extra";
import fetch from "node-fetch";
import logger from "loglevel";
import path from "path";
import JSONStream from "JSONStream";
import {
  processTar,
  makeDockerfile,
  getLatestBotpressImageTag,
  DockerCLIOpts,
  parseDockerOptions,
  defaultDockerOpts,
} from "./utils";
import chalk from "chalk";

const BP_PULL_ENDPOINT = "/api/v2/admin/management/versioning/export";

interface BPPullConfig {
  url: string;
  authToken: string;
}

export class BuildManager {
  private parentWorkDir: string;
  public builds: Build[] = [];

  constructor(baseDir: string = os.tmpdir()) {
    this.parentWorkDir = path.join(baseDir, "bp_image_builder");
  }

  async initialize(purge: boolean = true) {
    if (purge) {
      await this.purgeDir();
    }
  }

  async purgeDir() {
    await fs.emptyDir(this.parentWorkDir);
  }

  async create(opts: Partial<DockerCLIOpts> = null, name: string = null) {
    try {
      await fs.ensureDir(this.parentWorkDir);
    } catch (err) {
      throw new Error(
        `Unable to create temporary build directory: ${err.message}`
      );
    }

    if (!name) {
      name = randomWords({ exactly: 3, join: "_" });
    }
    const buildDir = path.join(this.parentWorkDir, name);
    await fs.ensureDir(buildDir);
    const dockerOpts = parseDockerOptions(opts);

    const build = new Build(buildDir, name, dockerOpts);
    this.builds.push(build);
    return build;
  }
}

class Build {
  docker: Docker;
  constructor(
    private _dir: string,
    public name: string,
    dockerOpts: DockerOptions = defaultDockerOpts
  ) {
    this.docker = new Docker(dockerOpts);
  }

  public get dir(): string {
    return this._dir;
  }

  async readFS(archivePath: string): Promise<NodeJS.ReadableStream> {
    const exists = await fs.pathExists(archivePath);
    if (!exists) {
      throw new Error(`Path ${archivePath} does not exist`);
    }
    logger.getLogger("reader").info(`Reading ${archivePath}`);
    return fs.createReadStream(archivePath).pipe(gunzip());
  }

  async readBP(config: BPPullConfig): Promise<NodeJS.ReadableStream> {
    const endpoint = new URL(BP_PULL_ENDPOINT, config.url);
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${config.authToken}` },
      size: 0,
      timeout: 500000,
    });
    logger
      .getLogger("reader")
      .info(`Downloading data from Botpress BPFS hosted at ${config.url}`);
    if (!res.ok) {
      const error = await res.json();

      throw new Error(
        `Archive download failed with error code ${res.status}: ${error.message}`
      );
    }
    return res.body.pipe(gunzip());
  }

  async build(
    contextStream: NodeJS.ReadableStream,
    baseImageTag: string = null,
    outputTag: string = null
  ): Promise<string> {
    try {
      await this.docker.ping();
    } catch (err) {
      throw new Error(
        `Could not communicate with the Docker daemon: ${err.message}`
      );
    }

    if (!outputTag) {
      outputTag = `bpexport:${this.name}`;
    }

    if (!baseImageTag) {
      baseImageTag = await getLatestBotpressImageTag();
    }

    logger
      .getLogger("docker")
      .info(`Creating docker image ${outputTag} based on ${baseImageTag}`);

    const dockerfile = makeDockerfile(baseImageTag);

    const tarStream = processTar(
      contextStream,
      dockerfile,
      logger.getLogger("build")
    );

    logger.getLogger("docker").info("Building image...");

    const buildStream = await this.docker.buildImage(tarStream, {
      t: outputTag,
    });

    buildStream.pipe(JSONStream.parse("stream")).on("data", (d: string) => {
      logger.getLogger("docker").info(chalk.blue(d));
    });

    let dockerError = null;

    buildStream.pipe(JSONStream.parse("error")).on("data", (d: string) => {
      logger.getLogger("docker").info(chalk.redBright(d));
      dockerError = new Error(d);
    });

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(buildStream, (err: Error, _) => {
        if (err || dockerError) {
          reject(err || dockerError);
        }
        resolve();
      });
    });

    return outputTag;
  }
}
