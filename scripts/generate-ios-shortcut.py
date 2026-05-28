#!/usr/bin/env python3
import plistlib
import subprocess
import tempfile
import uuid
from pathlib import Path

OUT_DIR = Path("shortcuts")
RAW_SHARE = OUT_DIR / "wklej-share-ios.raw.shortcut"
SIGNED_SHARE = OUT_DIR / "wklej-share-ios.shortcut"
RAW_WAIT_SHARE = OUT_DIR / "wklej-wait-share-ios.raw.shortcut"
SIGNED_WAIT_SHARE = OUT_DIR / "wklej-wait-share-ios.shortcut"
RAW_CREATE = OUT_DIR / "wklej-create-ios.raw.shortcut"
SIGNED_CREATE = OUT_DIR / "wklej-create-ios.shortcut"
RAW_JOIN = OUT_DIR / "wklej-join-ios.raw.shortcut"
SIGNED_JOIN = OUT_DIR / "wklej-join-ios.shortcut"
PLACEHOLDER = "\uFFFC"


def uid() -> str:
    return str(uuid.uuid4()).upper()


def attachment(value: dict) -> dict:
    return {"Value": value, "WFSerializationType": "WFTextTokenAttachment"}


def action_output(output_uuid: str, output_name: str) -> dict:
    return {"OutputUUID": output_uuid, "Type": "ActionOutput", "OutputName": output_name}


def shortcut_input() -> dict:
    return {"Type": "ExtensionInput"}


def variable(name: str) -> dict:
    return {"Type": "Variable", "VariableName": name}


def get_variable_action(output_uuid: str, name: str) -> dict:
    return raw_action(
        "is.workflow.actions.getvariable",
        {
            "UUID": output_uuid,
            "WFVariable": attachment(variable(name)),
        },
    )


def token_string(template: str, refs: list[dict]) -> dict:
    attachments = {}
    index = 0
    for ref in refs:
        pos = template.index(PLACEHOLDER, index)
        attachments[f"{{{pos}, 1}}"] = ref
        index = pos + 1
    return {
        "Value": {
            "string": template,
            "attachmentsByRange": attachments,
        },
        "WFSerializationType": "WFTextTokenString",
    }


def raw_action(identifier: str, params: dict | None = None) -> dict:
    return {
        "WFWorkflowActionIdentifier": identifier,
        "WFWorkflowActionParameters": params or {},
    }


def wait_action(seconds: int) -> dict:
    return raw_action(
        "is.workflow.actions.delay",
        {
            "WFDelayActionTime": seconds,
        },
    )


def share_shortcut() -> dict:
    ask_room_uuid = uid()
    shared_var_uuid = uid()
    shared_name_uuid = uid()
    shared_b64_uuid = uid()
    room_url_uuid = uid()
    file_name_uuid = uid()
    name_url_uuid = uid()
    b64_uuid = uid()
    b64_url_uuid = uid()
    url_uuid = uid()

    url_template = (
        "https://wklej.net/?shortcut=create"
        f"&room={PLACEHOLDER}"
        f"#filename={PLACEHOLDER}"
        "&mime=application/octet-stream"
        f"&file={PLACEHOLDER}"
    )

    return {
        "WFWorkflowName": "wklej share",
        "WFWorkflowClientRelease": "2.1",
        "WFWorkflowClientVersion": "3607.0.2",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowImportQuestions": [],
        "WFWorkflowTypes": ["ActionExtension"],
        "WFWorkflowQuickActionSurfaces": [],
        "WFWorkflowInputContentItemClasses": [
            "WFArticleContentItem",
            "WFAVAssetContentItem",
            "WFGenericFileContentItem",
            "WFImageContentItem",
            "WFPDFContentItem",
            "WFRichTextContentItem",
            "WFSafariWebPageContentItem",
            "WFStringContentItem",
            "WFURLContentItem",
        ],
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowIcon": {
            "WFWorkflowIconGlyphNumber": 61440,
            "WFWorkflowIconStartColor": 431817727,
        },
        "WFWorkflowActions": [
            raw_action(
                "is.workflow.actions.setvariable",
                {
                    "UUID": shared_var_uuid,
                    "WFVariableName": "shared",
                    "WFInput": attachment(shortcut_input()),
                },
            ),
            raw_action(
                "is.workflow.actions.comment",
                {
                    "WFCommentActionText": (
                        "Share a small file/text to wklej.net. The payload is placed in the URL fragment, "
                        "then sent only after browser E2EE/DataChannel is ready."
                    )
                },
            ),
            raw_action(
                "is.workflow.actions.ask",
                {
                    "UUID": ask_room_uuid,
                    "WFAskActionPrompt": "Room name",
                    "WFInputType": "Text",
                    "WFAllowsMultilineText": False,
                    "WFAskActionDefaultAnswer": "iosdrop",
                },
            ),
            raw_action(
                "is.workflow.actions.urlencode",
                {
                    "UUID": room_url_uuid,
                    "WFEncodeMode": "Encode",
                    "WFInput": attachment(action_output(ask_room_uuid, "Ask for Input")),
                },
            ),
            get_variable_action(shared_name_uuid, "shared"),
            raw_action(
                "is.workflow.actions.getitemname",
                {
                    "UUID": file_name_uuid,
                    "WFInput": attachment(action_output(shared_name_uuid, "Variable")),
                },
            ),
            raw_action(
                "is.workflow.actions.urlencode",
                {
                    "UUID": name_url_uuid,
                    "WFEncodeMode": "Encode",
                    "WFInput": attachment(action_output(file_name_uuid, "Name")),
                },
            ),
            get_variable_action(shared_b64_uuid, "shared"),
            raw_action(
                "is.workflow.actions.base64encode",
                {
                    "UUID": b64_uuid,
                    "WFEncodeMode": "Encode",
                    "WFBase64LineBreakMode": "None",
                    "WFInput": attachment(action_output(shared_b64_uuid, "Variable")),
                },
            ),
            raw_action(
                "is.workflow.actions.urlencode",
                {
                    "UUID": b64_url_uuid,
                    "WFEncodeMode": "Encode",
                    "WFInput": attachment(action_output(b64_uuid, "Base64 Encoded")),
                },
            ),
            raw_action(
                "is.workflow.actions.url",
                {
                    "UUID": url_uuid,
                    "WFURLActionURL": token_string(
                        url_template,
                        [
                            action_output(room_url_uuid, "URL Encoded Text"),
                            action_output(name_url_uuid, "URL Encoded Text"),
                            action_output(b64_url_uuid, "URL Encoded Text"),
                        ],
                    ),
                },
            ),
            raw_action(
                "is.workflow.actions.openurl",
                {
                    "WFInput": attachment(action_output(url_uuid, "URL")),
                },
            ),
        ],
    }


def wait_share_shortcut() -> dict:
    ask_room_uuid = uid()
    shared_var_uuid = uid()
    shared_name_uuid = uid()
    shared_b64_uuid = uid()
    room_url_uuid = uid()
    file_name_uuid = uid()
    name_url_uuid = uid()
    b64_uuid = uid()
    b64_url_uuid = uid()
    create_url_uuid = uid()
    attach_url_uuid = uid()

    create_template = (
        "https://wklej.net/?shortcut=create"
        f"&room={PLACEHOLDER}"
    )
    attach_template = (
        "https://wklej.net/shortcut-attach"
        f"?room={PLACEHOLDER}"
        "&targetRole=seed"
        f"&filename={PLACEHOLDER}"
        "&mime=application/octet-stream"
        f"&file={PLACEHOLDER}"
    )

    return {
        "WFWorkflowName": "wklej wait share",
        "WFWorkflowClientRelease": "2.1",
        "WFWorkflowClientVersion": "3607.0.2",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowImportQuestions": [],
        "WFWorkflowTypes": ["ActionExtension"],
        "WFWorkflowQuickActionSurfaces": [],
        "WFWorkflowInputContentItemClasses": [
            "WFArticleContentItem",
            "WFAVAssetContentItem",
            "WFGenericFileContentItem",
            "WFImageContentItem",
            "WFPDFContentItem",
            "WFRichTextContentItem",
            "WFSafariWebPageContentItem",
            "WFStringContentItem",
            "WFURLContentItem",
        ],
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowIcon": {
            "WFWorkflowIconGlyphNumber": 61440,
            "WFWorkflowIconStartColor": 431817727,
        },
        "WFWorkflowActions": [
            raw_action(
                "is.workflow.actions.setvariable",
                {
                    "UUID": shared_var_uuid,
                    "WFVariableName": "shared",
                    "WFInput": attachment(shortcut_input()),
                },
            ),
            raw_action(
                "is.workflow.actions.comment",
                {
                    "WFCommentActionText": (
                        "Reliable iOS flow: open a short room URL first, wait 20 seconds, "
                        "then hand off the shared item through the local service worker."
                    )
                },
            ),
            raw_action(
                "is.workflow.actions.ask",
                {
                    "UUID": ask_room_uuid,
                    "WFAskActionPrompt": "Room name",
                    "WFInputType": "Text",
                    "WFAllowsMultilineText": False,
                    "WFAskActionDefaultAnswer": "iosdrop",
                },
            ),
            raw_action(
                "is.workflow.actions.urlencode",
                {
                    "UUID": room_url_uuid,
                    "WFEncodeMode": "Encode",
                    "WFInput": attachment(action_output(ask_room_uuid, "Ask for Input")),
                },
            ),
            raw_action(
                "is.workflow.actions.url",
                {
                    "UUID": create_url_uuid,
                    "WFURLActionURL": token_string(
                        create_template,
                        [action_output(room_url_uuid, "URL Encoded Text")],
                    ),
                },
            ),
            raw_action("is.workflow.actions.openurl", {"WFInput": attachment(action_output(create_url_uuid, "URL"))}),
            wait_action(20),
            get_variable_action(shared_name_uuid, "shared"),
            raw_action(
                "is.workflow.actions.getitemname",
                {
                    "UUID": file_name_uuid,
                    "WFInput": attachment(action_output(shared_name_uuid, "Variable")),
                },
            ),
            raw_action(
                "is.workflow.actions.urlencode",
                {
                    "UUID": name_url_uuid,
                    "WFEncodeMode": "Encode",
                    "WFInput": attachment(action_output(file_name_uuid, "Name")),
                },
            ),
            get_variable_action(shared_b64_uuid, "shared"),
            raw_action(
                "is.workflow.actions.base64encode",
                {
                    "UUID": b64_uuid,
                    "WFEncodeMode": "Encode",
                    "WFBase64LineBreakMode": "None",
                    "WFInput": attachment(action_output(shared_b64_uuid, "Variable")),
                },
            ),
            raw_action(
                "is.workflow.actions.urlencode",
                {
                    "UUID": b64_url_uuid,
                    "WFEncodeMode": "Encode",
                    "WFInput": attachment(action_output(b64_uuid, "Base64 Encoded")),
                },
            ),
            raw_action(
                "is.workflow.actions.url",
                {
                    "UUID": attach_url_uuid,
                    "WFURLActionURL": token_string(
                        attach_template,
                        [
                            action_output(room_url_uuid, "URL Encoded Text"),
                            action_output(name_url_uuid, "URL Encoded Text"),
                            action_output(b64_url_uuid, "URL Encoded Text"),
                        ],
                    ),
                },
            ),
            raw_action("is.workflow.actions.openurl", {"WFInput": attachment(action_output(attach_url_uuid, "URL"))}),
        ],
    }


def join_shortcut() -> dict:
    return room_shortcut(
        workflow_name="wklej join",
        intent="join",
        comment=(
            "Join a waiting wklej.net named room from iPhone/iPad. "
            "Payload transfer still starts only after browser E2EE/DataChannel is ready."
        ),
        glyph=59836,
        color=425133311,
    )


def create_shortcut() -> dict:
    return room_shortcut(
        workflow_name="wklej create",
        intent="create",
        comment=(
            "Create a wklej.net named room from iPhone/iPad. "
            "This shortcut does not touch shared files, so it is the most reliable room starter."
        ),
        glyph=61440,
        color=431817727,
    )


def room_shortcut(workflow_name: str, intent: str, comment: str, glyph: int, color: int) -> dict:
    ask_room_uuid = uid()
    url_uuid = uid()
    url_template = f"https://wklej.net/?shortcut={intent}&room={PLACEHOLDER}"
    return {
        "WFWorkflowName": workflow_name,
        "WFWorkflowClientRelease": "2.1",
        "WFWorkflowClientVersion": "3607.0.2",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowHasShortcutInputVariables": False,
        "WFWorkflowImportQuestions": [],
        "WFWorkflowTypes": [],
        "WFWorkflowQuickActionSurfaces": ["WFWorkflowQuickActionSurfacesHomeScreen"],
        "WFWorkflowInputContentItemClasses": [],
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowIcon": {
            "WFWorkflowIconGlyphNumber": glyph,
            "WFWorkflowIconStartColor": color,
        },
        "WFWorkflowActions": [
            raw_action(
                "is.workflow.actions.comment",
                {"WFCommentActionText": comment},
            ),
            raw_action(
                "is.workflow.actions.ask",
                {
                    "UUID": ask_room_uuid,
                    "WFAskActionPrompt": "Room name",
                    "WFInputType": "Text",
                    "WFAllowsMultilineText": False,
                    "WFAskActionDefaultAnswer": "iosdrop",
                },
            ),
            raw_action(
                "is.workflow.actions.url",
                {
                    "UUID": url_uuid,
                    "WFURLActionURL": token_string(
                        url_template,
                        [action_output(ask_room_uuid, "Ask for Input")],
                    ),
                },
            ),
            raw_action(
                "is.workflow.actions.openurl",
                {
                    "WFInput": attachment(action_output(url_uuid, "URL")),
                },
            ),
        ],
    }


def write_shortcut(path: Path, shortcut: dict) -> None:
    with path.open("wb") as f:
        plistlib.dump(shortcut, f, fmt=plistlib.FMT_XML, sort_keys=False)


def sign_shortcut(raw: Path, signed: Path) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        signed_tmp = Path(tmp) / signed.name
        sign_error = None
        for mode in ("anyone", "people-who-know-me"):
            try:
                subprocess.run(
                    [
                        "shortcuts",
                        "sign",
                        "--mode",
                        mode,
                        "--input",
                        str(raw),
                        "--output",
                        str(signed_tmp),
                    ],
                    check=True,
                )
                signed.write_bytes(signed_tmp.read_bytes())
                return mode
            except subprocess.CalledProcessError as exc:
                sign_error = exc
        raise sign_error


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)

    targets = [
        (RAW_SHARE, SIGNED_SHARE, share_shortcut()),
        (RAW_WAIT_SHARE, SIGNED_WAIT_SHARE, wait_share_shortcut()),
        (RAW_CREATE, SIGNED_CREATE, create_shortcut()),
        (RAW_JOIN, SIGNED_JOIN, join_shortcut()),
    ]

    for raw, signed, shortcut in targets:
        write_shortcut(raw, shortcut)
        mode = sign_shortcut(raw, signed)
        print(f"wrote {signed} (signed with mode: {mode})")


if __name__ == "__main__":
    main()
