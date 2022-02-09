import { Alert, Button, InputGroup, Label, Intent } from "@blueprintjs/core";
import React, { useCallback, useEffect, useRef, useState } from "react";
import getGraph from "roamjs-components/util/getGraph";
import createOverlayRender from "roamjs-components/util/createOverlayRender";
import { render as renderToast } from "roamjs-components/components/Toast";
import { v4 } from "uuid";
import getBasicTreeByParentUid from "roamjs-components/queries/getBasicTreeByParentUid";
import getSubTree from "roamjs-components/util/getSubTree";
import getAuthorizationHeader from "roamjs-components/util/getAuthorizationHeader";
import { addTokenDialogCommand } from "roamjs-components/components/TokenDialog";

// These RTC objects are not JSON serializable -.-
const serialize = ({
  candidates,
  description,
  label,
}: {
  candidates: RTCIceCandidate[];
  description: RTCSessionDescriptionInit;
  label: string;
}) =>
  window.btoa(
    JSON.stringify({
      description: {
        type: description.type,
        sdp: description.sdp,
      },
      candidates: candidates.map((c) => c.toJSON()),
      label,
    })
  );

const deserialize = (
  s: string
): {
  candidates: RTCIceCandidate[];
  description: RTCSessionDescriptionInit;
  label: string;
} => JSON.parse(window.atob(s));

const gatherCandidates = (con: RTCPeerConnection) => {
  const candidates: RTCIceCandidate[] = [];
  return new Promise<RTCIceCandidate[]>((resolve) => {
    con.onicegatheringstatechange = (e) =>
      (e.target as RTCPeerConnection).iceGatheringState === "complete" &&
      resolve(candidates);
    con.onicecandidate = (c) => {
      if (c.candidate) {
        candidates.push(c.candidate);
      }
    };
  });
};

export type json =
  | string
  | number
  | boolean
  | null
  | { toJSON: () => string }
  | json[]
  | { [key: string]: json };
type MessageHandlers = {
  [operation: string]: (data: json, graph: string) => void;
};
type Status = "DISCONNECTED" | "PENDING" | "CONNECTED";

export const messageHandlers: MessageHandlers = {
  ERROR: ({ message }: { message: string }) =>
    renderToast({
      id: "websocket-error",
      content: message,
      intent: "danger",
    }),
  AUTHENTICATION: (props: { success: boolean; reason?: string }) => {
    if (props.success) {
      roamJsBackend.status = "CONNECTED";
      renderToast({
        id: "multiplayer-success",
        content: "Successfully connected to RoamJS Multiplayer!",
        intent: Intent.SUCCESS,
      });
    } else {
      roamJsBackend.status = "DISCONNECTED";
      roamJsBackend.channel.close();
      renderToast({
        id: "multiplayer-failure",
        content: `Failed to connect to RoamJS Multiplayer: ${props.reason}`,
        intent: Intent.DANGER,
      });
    }
  },
  INITIALIZE_P2P: (props: { to: string; graph: string }) => {
    getSetupCode({ label: props.graph }).then((offer) =>
      sendToBackend({ operation: "OFFER", data: { to: props.to, offer } })
    );
  },
  OFFER: (props: { to: string; offer: string; graph: string }) => {
    getConnectCode({ offer: props.offer, label: props.graph }).then((answer) =>
      sendToBackend({ operation: "ANSWER", data: { to: props.to, answer } })
    );
  },
  ANSWER: (props: { answer: string }) => {
    receiveAnswer({ answer: props.answer });
  },
};
export const ONLINE_GRAPHS_ID = "roamjs-online-graphs-container";
const updateOnlineGraphs = () => {
  const onlineElement = document.getElementById(ONLINE_GRAPHS_ID);
  if (onlineElement) {
    onlineElement.dispatchEvent(new Event("roamjs:multiplayer:graphs"));
  }
};
export const connectedGraphs: {
  [graph: string]: {
    connection: RTCPeerConnection;
    channel: RTCDataChannel;
    status: Status;
  };
} = {};
export const roamJsBackend: {
  channel?: WebSocket;
  status: Status;
} = {
  status: "DISCONNECTED",
};
export const sendToBackend = ({
  operation,
  data = {},
}: {
  operation: string;
  data?: { [key: string]: json };
}) =>
  roamJsBackend.channel.send(
    JSON.stringify({
      action: "sendmessage",
      data: { operation, ...data },
    })
  );

type AlertProps = { onClose: () => void };
const onError = (e: { error: Error } & Event) => {
  if (!e.error.message.includes("Transport channel closed")) {
    // handled in disconnect
    console.error(e);
    renderToast({
      id: "multiplayer-send-error",
      content: `Multiplayer Error: ${e.error}`,
      intent: "danger",
    });
  }
};
const onDisconnect = (graph: string) => () => {
  renderToast({
    id: "multiplayer-disconnect",
    content: `Disconnected from graph ${graph}`,
    intent: "warning",
  });
  connectedGraphs[graph].status = "DISCONNECTED";
  updateOnlineGraphs();
};
const onConnect = ({
  e,
  connection,
  channel,
  callback,
}: {
  e: MessageEvent;
  channel: RTCDataChannel;
  connection: RTCPeerConnection;
  callback: () => void;
}) => {
  const name = e.data;
  renderToast({
    id: `multiplayer-on-connect`,
    content: `Successfully connected to graph: ${name}!`,
  });
  callback();
  connectedGraphs[name] = {
    connection,
    channel,
    status: "CONNECTED",
  };
  updateOnlineGraphs();
  const ongoingMessages: { [uuid: string]: string[] } = {};
  channel.addEventListener("message", (e) => {
    const { message, uuid, chunk, total } = JSON.parse(e.data);
    if (!ongoingMessages[uuid]) {
      ongoingMessages[uuid] = [];
    }
    const ongoingMessage = ongoingMessages[uuid];
    ongoingMessage[chunk] = message;
    if (ongoingMessage.filter((c) => !!c).length === total) {
      console.log("Received full message");
      delete ongoingMessages[uuid];
      const { operation, ...data } = JSON.parse(ongoingMessage.join(""));
      messageHandlers[operation]?.(data, name);
    } else {
      console.log(`Received chunk ${chunk + 1} of ${total}`);
    }
  });
  channel.onclose = onDisconnect(name);
};

const getPeerConnection = (onClose?: () => void) => {
  const connection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  const disconnectStateHandler = () => {
    if (
      ["disconnected", "failed", "closed"].includes(
        connection.iceConnectionState
      )
    ) {
      renderToast({
        id: "multiplayer-failed-connection",
        content: "Failed to connect to graph",
      });
      onClose?.();
    }
  };
  connection.addEventListener(
    "iceconnectionstatechange",
    disconnectStateHandler
  );
  return {
    connection,
    cleanup: () =>
      connection.removeEventListener(
        "iceconnectionstatechange",
        disconnectStateHandler
      ),
  };
};

export const getSetupCode = ({
  onClose,
  label = v4(),
}: {
  onClose?: () => void;
  label?: string;
}) => {
  const { connection, cleanup } = getPeerConnection(onClose);
  const sendChannel = connection.createDataChannel(label);
  connectedGraphs[label] = {
    connection,
    channel: sendChannel,
    status: "PENDING",
  };
  updateOnlineGraphs();
  const connectionHandler = (e: MessageEvent) => {
    onConnect({
      e,
      connection,
      channel: sendChannel,
      callback: () => {
        delete connectedGraphs[label];
        sendChannel.removeEventListener("message", connectionHandler);
        onClose?.();
        cleanup();
      },
    });
  };
  sendChannel.addEventListener("message", connectionHandler);
  sendChannel.onerror = onError;
  sendChannel.onopen = () => {
    sendChannel.send(getGraph());
  };
  return Promise.all([
    gatherCandidates(connection),
    connection.createOffer().then((offer) => {
      return connection.setLocalDescription(offer);
    }),
  ]).then(([candidates]) => {
    return serialize({
      candidates,
      description: connection.localDescription,
      label,
    });
  });
};

const getConnectCode = ({
  offer,
  onClose,
  label = v4(),
}: {
  offer: string;
  onClose?: () => void;
  label?: string;
}) => {
  const { connection, cleanup } = getPeerConnection(onClose);
  connection.ondatachannel = (event) => {
    const receiveChannel = event.channel;
    connectedGraphs[label] = {
      connection,
      channel: receiveChannel,
      status: "PENDING",
    };
    updateOnlineGraphs();
    const connectionHandler = (e: MessageEvent) => {
      onConnect({
        e,
        connection,
        channel: receiveChannel,
        callback: () => {
          delete connectedGraphs[label];
          cleanup();
          receiveChannel.send(getGraph());
          receiveChannel.removeEventListener("message", connectionHandler);
        },
      });
    };
    receiveChannel.addEventListener("message", connectionHandler);
    receiveChannel.onopen = onClose;
    receiveChannel.onerror = onError;
  };
  return Promise.all([
    gatherCandidates(connection),
    new Promise<string>((resolve) => {
      const { candidates, description, label } = deserialize(offer);
      connection
        .setRemoteDescription(new RTCSessionDescription(description))
        .then(() => {
          return Promise.all(
            candidates.map((c) =>
              connection.addIceCandidate(new RTCIceCandidate(c))
            )
          );
        })
        .then(() => {
          return connection.createAnswer();
        })
        .then((answer) =>
          connection.setLocalDescription(answer).then(() => resolve(label))
        );
    }),
  ]).then(([candidates, label]) => {
    return serialize({
      candidates,
      description: connection.localDescription,
      label,
    });
  });
};

const receiveAnswer = ({ answer }: { answer: string }) => {
  const { candidates, description, label } = deserialize(answer);
  const connection = connectedGraphs[label].connection;
  connection
    .setRemoteDescription(new RTCSessionDescription(description))
    .then(() =>
      Promise.all(
        candidates.map((c) =>
          connection.addIceCandidate(new RTCIceCandidate(c))
        )
      )
    );
};

const SetupAlert = ({ onClose }: AlertProps) => {
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [readyToRecieve, setReadyToRecieve] = useState(false);
  const [code, setCode] = useState("");
  const [answer, setAnswer] = useState("");
  useEffect(() => {
    getSetupCode({ onClose }).then(setCode);
  }, [setLoading]);
  return (
    <Alert
      loading={!readyToRecieve || loading}
      isOpen={true}
      onConfirm={() => {
        setLoading(true);
        receiveAnswer({ answer });
      }}
      canOutsideClickCancel
      confirmButtonText={"Connect"}
      onCancel={() => {
        onClose();
      }}
    >
      <p>
        Click the button below to copy the handshake code and send it to your
        peer:
      </p>
      <p>
        <Button
          style={{ minWidth: 120 }}
          disabled={!code || loading}
          onClick={() => {
            window.navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => {
              setReadyToRecieve(true);
              setCopied(false);
            }, 3000);
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </Button>
      </p>
      <p>Then, enter the handshake code sent by your peer:</p>
      <Label>
        Peer's Handshake Code
        <InputGroup
          value={answer}
          disabled={!readyToRecieve || loading}
          onChange={(e) => {
            setAnswer(e.target.value);
            setLoading(!e.target.value);
          }}
        />
      </Label>
      <p>Finally, click connect below:</p>
    </Alert>
  );
};

const ConnectAlert = ({ onClose }: AlertProps) => {
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [offer, setOffer] = useState("");
  const onConfirm = useCallback(() => {
    setLoading(true);
    getConnectCode({
      offer,
      onClose,
    }).then((code) => {
      window.navigator.clipboard.writeText(code);
      setCopied(true);
    });
  }, [setLoading, offer, setCopied]);
  return (
    <Alert
      loading={loading}
      isOpen={true}
      onConfirm={onConfirm}
      canOutsideClickCancel
      confirmButtonText={"Connect"}
      onCancel={() => {
        onClose();
      }}
    >
      {copied ? (
        <p>A response handshake code was copied! Send it to your peer.</p>
      ) : (
        <>
          <p>Enter the handshake code sent by your peer:</p>
          <Label>
            Peer's Handshake Code
            <InputGroup
              value={offer}
              onChange={(e) => {
                setOffer(e.target.value);
                setLoading(!e.target.value);
              }}
              disabled={loading}
            />
          </Label>
          <p>Then, click connect below:</p>
        </>
      )}
    </Alert>
  );
};

const MESSAGE_LIMIT = 15750; // 16KB minus 250b buffer for metadata

export const toggleOnAsync = () => {
  roamJsBackend.status = "PENDING";
  roamJsBackend.channel = new WebSocket(process.env.WEB_SOCKET_URL);
  roamJsBackend.channel.onopen = () => {
    sendToBackend({
      operation: "AUTHENTICATION",
      data: { token: getAuthorizationHeader(), graph: getGraph() },
    });
  };

  roamJsBackend.channel.onclose = () => {
    roamJsBackend.status = "DISCONNECTED";
    renderToast({
      id: "multiplayer-success",
      content: "Disconnected from RoamJS Multiplayer",
      intent: Intent.WARNING,
    });
  };

  roamJsBackend.channel.onmessage = (data) => {
    console.log(`Received message on ${new Date()}`);
    console.log(data.data);
    const { operation, ...props } = JSON.parse(data.data);
    const handler = messageHandlers[operation];
    if (handler) handler(props, "");
    else if (props.message === "Internal server srror")
      renderToast({
        id: "websocket-error",
        content: `Unknown Internal Server Error. Request ID: ${props.requestId}`,
      });
    else
      renderToast({
        id: "websocket-error",
        content: `Unknown websocket operation: ${operation}`,
        intent: "danger",
      });
  };
  addTokenDialogCommand();
};

const setupMultiplayer = (configUid: string) => {
  const tree = getBasicTreeByParentUid(configUid);
  const asyncModeTree = getSubTree({ tree, key: "Asynchronous" });
  return {
    addGraphListener: ({
      operation,
      handler,
    }: {
      operation: string;
      handler: (e: json, graph: string) => void;
    }) => {
      messageHandlers[operation] = handler;
    },
    removeGraphListener: ({ operation }: { operation: string }) => {
      delete messageHandlers[operation];
    },
    sendToGraph: ({
      graph,
      operation,
      data = {},
    }: {
      graph: string;
      operation: string;
      data?: { [k: string]: json };
    }) => {
      const connection = connectedGraphs[graph];
      if (connection?.status === "CONNECTED") {
        const message = JSON.stringify({ operation, ...data });
        const uuid = v4();
        const size = new Blob([message]).size;
        const total = Math.ceil(size / MESSAGE_LIMIT);
        const chunkSize = Math.ceil(message.length / total);
        for (let chunk = 0; chunk < total; chunk++) {
          connection.channel.send(
            JSON.stringify({
              message: message.slice(
                chunkSize * chunk,
                chunkSize * (chunk + 1)
              ),
              uuid,
              chunk,
              total,
            })
          );
        }
      } else if (
        roamJsBackend.channel &&
        roamJsBackend.status === "CONNECTED"
      ) {
        sendToBackend({
          operation: "PROXY",
          data: { ...data, graph, proxyOperation: operation },
        });
      }
    },
    getConnectedGraphs: () =>
      Object.keys(connectedGraphs).filter(
        (g) => connectedGraphs[g].status === "CONNECTED"
      ),
    enable: () => {
      if (asyncModeTree.uid) {
        toggleOnAsync();
      } else {
        window.roamAlphaAPI.ui.commandPalette.addCommand({
          label: "Setup Multiplayer",
          callback: () => {
            createOverlayRender<Omit<AlertProps, "onClose">>(
              "multiplayer-setup",
              SetupAlert
            )({ messageHandlers });
          },
        });
        window.roamAlphaAPI.ui.commandPalette.addCommand({
          label: "Connect To Graph",
          callback: () => {
            createOverlayRender<Omit<AlertProps, "onClose">>(
              "multiplayer-connect",
              ConnectAlert
            )({ messageHandlers });
          },
        });
      }
    },
    disable: () => {
      window.roamAlphaAPI.ui.commandPalette.removeCommand({
        label: "Connect To Graph",
      });
      window.roamAlphaAPI.ui.commandPalette.removeCommand({
        label: "Setup Multiplayer",
      });
      Object.keys(connectedGraphs).forEach((g) => delete connectedGraphs[g]);
    },
  };
};

export default setupMultiplayer;