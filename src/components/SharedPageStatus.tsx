import {
  Button,
  Classes,
  Dialog,
  InputGroup,
  Intent,
  Label,
  Popover,
  Spinner,
  Tooltip,
} from "@blueprintjs/core";
import { useState, useRef, useEffect, useCallback } from "react";
import renderWithUnmount from "roamjs-components/util/renderWithUnmount";
import { removeSharedPage } from "../messages/sharePageWithGraph";
import { render as renderToast } from "roamjs-components/components/Toast";
import apiClient from "../apiClient";
import type { SamePageProps } from "../types";
import getPageTitleByPageUid from "roamjs-components/queries/getPageTitleByPageUid";
import getTextByBlockUid from "roamjs-components/queries/getTextByBlockUid";

type Props = {
  parentUid: string;
  sendToGraph: SamePageProps["sendToGraph"];
};

type Client = { instance: string };

const ConnectedClients = ({ uid }: { uid: string }) => {
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState<Client[]>([]);
  useEffect(() => {
    apiClient<{ clients: Client[] }>({
      method: "list-page-instances",
      data: { uid },
    })
      .then((r) => setClients(r.clients))
      .finally(() => setLoading(false));
  }, [setLoading]);
  return (
    <div className="flex p-4 rounded-md">
      {loading ? (
        <Spinner />
      ) : (
        <ul>
          {clients.map((c) => (
            <li key={c.instance}>{c.instance}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

const InviteClient = ({
  parentUid,
  sendToGraph,
  loading,
  setLoading,
}: {
  loading: boolean;
  sendToGraph: SamePageProps["sendToGraph"];
  parentUid: string;
  setLoading: (f: boolean) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [innerLoading, setInnerLoading] = useState(false);
  const closeDialog = useCallback(() => {
    setIsOpen(false);
    setLoading(false);
  }, [setIsOpen, setLoading]);
  const [instance, setInstance] = useState("");
  const onSubmit = useCallback(() => {
    setInnerLoading(true);
    return apiClient<{ id: string; created: boolean }>({
      // TODO replace with just a get for the id
      method: "init-shared-page",
      data: {
        uid: parentUid,
      },
    }).then((r) => {
      const title = getPageTitleByPageUid(parentUid);
      sendToGraph({
        graph: instance,
        operation: "SHARE_PAGE",
        data: {
          id: r.id,
          uid: parentUid,
          title: title || getTextByBlockUid(parentUid),
          isPage: !!title,
        },
      });
      renderToast({
        id: "share-page-success",
        content: `Successfully shared page with ${instance}! We will now await for them to accept.`,
      });
      closeDialog();
    });
  }, [parentUid, instance, closeDialog]);
  return (
    <>
      <Tooltip content={"Invite Client"}>
        <Button
          icon={"plus"}
          minimal
          disabled={loading}
          onClick={() => {
            setIsOpen(true);
            setLoading(true);
          }}
        />
      </Tooltip>
      <Dialog
        isOpen={isOpen}
        title={"Invite Client"}
        onClose={closeDialog}
        canOutsideClickClose
        canEscapeKeyClose
        autoFocus={false}
      >
        <div className={Classes.DIALOG_BODY}>
          <Label>
            Graph
            <InputGroup
              value={instance}
              onChange={(e) => setInstance(e.target.value)}
            />
          </Label>
        </div>
        <div className={Classes.DIALOG_FOOTER}>
          <div className={Classes.DIALOG_FOOTER_ACTIONS}>
            <Button
              text={"Cancel"}
              onClick={closeDialog}
              disabled={innerLoading}
            />
            <Button
              text={"Send"}
              intent={Intent.PRIMARY}
              onClick={onSubmit}
              disabled={innerLoading}
            />
          </div>
        </div>
      </Dialog>
    </>
  );
};

const SharedPageStatus = ({ parentUid, sendToGraph }: Props) => {
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  return (
    <span className="flex gap-4 items-center text-lg mb-8" ref={containerRef}>
      <i>Shared</i>
      <Tooltip content={"Clients Connected"}>
        <Popover
          content={<ConnectedClients uid={parentUid} />}
          target={<Button icon={"info-sign"} minimal disabled={loading} />}
        />
      </Tooltip>
      <InviteClient
        parentUid={parentUid}
        sendToGraph={sendToGraph}
        loading={loading}
        setLoading={setLoading}
      />
      <Tooltip content={"Disconnect Shared Page"}>
        <Button
          disabled={loading}
          icon={"th-disconnect"}
          minimal
          onClick={() => {
            setLoading(true);
            apiClient<{ id: string; created: boolean }>({
              method: "disconnect-shared-page",
              data: { uid: parentUid },
            })
              .then(() => {
                removeSharedPage(parentUid);
                containerRef.current.parentElement.remove();
              })
              .catch(() =>
                renderToast({
                  content: `Successfully disconnected ${parentUid} from being shared.`,
                  id: "disconnect-shared-page",
                })
              )
              .finally(() => setLoading(false));
          }}
        />
      </Tooltip>
    </span>
  );
};

export const render = ({
  parent,
  ...props
}: { parent: HTMLElement } & Props) => {
  renderWithUnmount(<SharedPageStatus {...props} />, parent);
};

export default SharedPageStatus;