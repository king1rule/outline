// @flow
import { formatDistanceToNow } from "date-fns";
import invariant from "invariant";
import { deburr, sortBy } from "lodash";
import { observable } from "mobx";
import { observer, inject } from "mobx-react";
import * as React from "react";
import type { RouterHistory, Match } from "react-router-dom";
import { withRouter } from "react-router-dom";
import parseDocumentSlug from "shared/utils/parseDocumentSlug";
import AuthStore from "stores/AuthStore";
import DocumentsStore from "stores/DocumentsStore";
import PoliciesStore from "stores/PoliciesStore";
import RevisionsStore from "stores/RevisionsStore";
import SharesStore from "stores/SharesStore";
import UiStore from "stores/UiStore";
import Document from "models/Document";
import Revision from "models/Revision";
import Error404 from "scenes/Error404";
import ErrorOffline from "scenes/ErrorOffline";
import HideSidebar from "./HideSidebar";
import Loading from "./Loading";
import { type LocationWithState, type NavigationNode } from "types";
import { NotFoundError, OfflineError } from "utils/errors";
import { matchDocumentEdit, updateDocumentUrl } from "utils/routeHelpers";
import { isInternalUrl } from "utils/urls";
type Props = {|
  match: Match,
  auth: AuthStore,
  location: LocationWithState,
  shares: SharesStore,
  documents: DocumentsStore,
  policies: PoliciesStore,
  revisions: RevisionsStore,
  auth: AuthStore,
  ui: UiStore,
  history: RouterHistory,
  children: (any) => React.Node,
|};

const sharedTreeCache = {};

@observer
class DataLoader extends React.Component<Props> {
  sharedTree: ?NavigationNode;
  @observable document: ?Document;
  @observable revision: ?Revision;
  @observable error: ?Error;

  componentDidMount() {
    const { documents, match } = this.props;
    this.document = documents.getByUrl(match.params.documentSlug);
    this.sharedTree = this.document
      ? sharedTreeCache[this.document.id]
      : undefined;
    this.loadDocument();
  }

  componentDidUpdate(prevProps: Props) {
    // If we have the document in the store, but not it's policy then we need to
    // reload from the server otherwise the UI will not know which authorizations
    // the user has
    if (this.document) {
      const document = this.document;
      const policy = this.props.policies.get(document.id);

      if (
        !policy &&
        !this.error &&
        this.props.auth.user &&
        this.props.auth.user.id
      ) {
        this.loadDocument();
      }
    }

    // Also need to load the revision if it changes
    const { revisionId } = this.props.match.params;
    if (
      prevProps.match.params.revisionId !== revisionId &&
      revisionId &&
      revisionId !== "latest"
    ) {
      this.loadRevision();
    }
  }

  get isEditing() {
    return this.props.match.path === matchDocumentEdit;
  }

  onSearchLink = async (term: string) => {
    if (isInternalUrl(term)) {
      // search for exact internal document
      const slug = parseDocumentSlug(term);
      try {
        const {
          document,
        }: { document: Document } = await this.props.documents.fetch(slug);

        const time = formatDistanceToNow(Date.parse(document.updatedAt), {
          addSuffix: true,
        });
        return [
          {
            title: document.title,
            subtitle: `Updated ${time}`,
            url: document.url,
          },
        ];
      } catch (error) {
        // NotFoundError could not find document for slug
        if (!(error instanceof NotFoundError)) {
          throw error;
        }
      }
    }

    // default search for anything that doesn't look like a URL
    const results = await this.props.documents.searchTitles(term);

    return sortBy(
      results.map((document) => {
        const time = formatDistanceToNow(Date.parse(document.updatedAt), {
          addSuffix: true,
        });
        return {
          title: document.title,
          subtitle: `Updated ${time}`,
          url: document.url,
        };
      }),
      (document) =>
        deburr(document.title)
          .toLowerCase()
          .startsWith(deburr(term).toLowerCase())
          ? -1
          : 1
    );
  };

  onCreateLink = async (title: string) => {
    const document = this.document;
    invariant(document, "document must be loaded to create link");

    const newDocument = await this.props.documents.create({
      collectionId: document.collectionId,
      parentDocumentId: document.parentDocumentId,
      title,
      text: "",
    });

    return newDocument.url;
  };

  loadRevision = async () => {
    const { revisionId } = this.props.match.params;
    this.revision = await this.props.revisions.fetch(revisionId);
  };

  loadDocument = async () => {
    const { shareId, documentSlug, revisionId } = this.props.match.params;

    // sets the document as active in the sidebar if we already have it loaded
    if (this.document) {
      this.props.ui.setActiveDocument(this.document);
    }

    try {
      const response = await this.props.documents.fetch(documentSlug, {
        shareId,
      });

      this.sharedTree = response.sharedTree;
      this.document = response.document;
      sharedTreeCache[this.document.id] = response.sharedTree;

      if (revisionId && revisionId !== "latest") {
        await this.loadRevision();
      } else {
        this.revision = undefined;
      }
    } catch (err) {
      this.error = err;
      return;
    }

    const document = this.document;

    if (document) {
      const can = this.props.policies.abilities(document.id);

      // sets the document as active in the sidebar, ideally in the future this
      // will be route driven.
      this.props.ui.setActiveDocument(document);

      // If we're attempting to update an archived, deleted, or otherwise
      // uneditable document then forward to the canonical read url.
      if (!can.update && this.isEditing) {
        this.props.history.push(document.url);
        return;
      }

      // Prevents unauthorized request to load share information for the document
      // when viewing a public share link
      if (can.read) {
        this.props.shares.fetch(document.id).catch((err) => {
          if (!(err instanceof NotFoundError)) {
            throw err;
          }
        });
      }

      const isMove = this.props.location.pathname.match(/move$/);
      const canRedirect = !revisionId && !isMove && !shareId;
      if (canRedirect) {
        const canonicalUrl = updateDocumentUrl(this.props.match.url, document);
        if (this.props.location.pathname !== canonicalUrl) {
          this.props.history.replace(canonicalUrl);
        }
      }
    }
  };

  render() {
    const { location, policies, auth, ui } = this.props;

    if (this.error) {
      return this.error instanceof OfflineError ? (
        <ErrorOffline />
      ) : (
        <Error404 />
      );
    }

    const team = auth.team;
    const document = this.document;
    const revision = this.revision;

    if (!document || !team) {
      return (
        <>
          <Loading location={location} />
          {this.isEditing && <HideSidebar ui={ui} />}
        </>
      );
    }

    const abilities = policies.abilities(document.id);

    // We do not want to remount the document when changing from view->edit
    // on the multiplayer flag as the doc is guaranteed to be upto date.
    const key = team.collaborativeEditing
      ? ""
      : this.isEditing
      ? "editing"
      : "read-only";

    return (
      <React.Fragment key={key}>
        {this.isEditing && <HideSidebar ui={ui} />}
        {this.props.children({
          document,
          revision,
          abilities,
          isEditing: this.isEditing,
          readOnly: !this.isEditing || !abilities.update || document.isArchived,
          onSearchLink: this.onSearchLink,
          onCreateLink: this.onCreateLink,
          sharedTree: this.sharedTree,
        })}
      </React.Fragment>
    );
  }
}

export default withRouter(
  inject(
    "ui",
    "auth",
    "documents",
    "revisions",
    "policies",
    "shares"
  )(DataLoader)
);
