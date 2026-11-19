// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20BalanceRead {
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title WireTapeRegistry
 * @notice Immutable hourly Merkle tape registry for WireCopy source-verified AI research findings
 *         on Robinhood Chain (chain ID 4663).
 *
 * Security & Trust Model:
 *  1. Zero custody / zero approvals: never holds ETH or ERC-20 tokens, no payable functions, no transferFrom.
 *  2. Append-only newsroom tape: once `epochHour` is sealed, its `merkleRoot` cannot be edited or erased
 *     by anyone (including owner or sealer). Unsealed hours remain visibly zero (`sealedAt == 0`).
 *  3. Sorted-pair Keccak-256 verification: anyone can verify any `ON THE WIRE` finding leaf onchain via
 *     `verifyFindingLeaf` or client-side in browser/CLI against `getTapeSeal(epochHour)`.
 *  4. One-time token binding: `bindToken` binds the `$WIRECOPY` ERC-20 contract once for read-only `tierOf`.
 */
contract WireTapeRegistry {
    struct TapeSeal {
        bytes32 merkleRoot;
        uint64 sealedAt;
        uint32 dispatchCount;
        uint32 wiredFindingCount;
    }

    error Unauthorized();
    error ZeroValue();
    error AlreadySealed(uint64 epochHour);
    error TokenAlreadyBound();

    uint256 public constant PRESS_PASS_MIN = 1_000_000 ether;
    uint256 public constant BUREAU_CHIEF_MIN = 5_000_000 ether;

    address public owner;
    address public sealer;
    address public wireToken;

    uint64 public latestEpoch;
    uint64 public totalTapesSealed;

    mapping(uint64 => TapeSeal) private _tapes;

    event TapeSealed(
        uint64 indexed epochHour,
        bytes32 indexed merkleRoot,
        uint32 dispatchCount,
        uint32 wiredFindingCount,
        uint64 sealedAt
    );
    event SealerUpdated(address indexed previousSealer, address indexed newSealer);
    event WireTokenBound(address indexed token);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        owner = msg.sender;
        sealer = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        emit SealerUpdated(address(0), msg.sender);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlySealer() {
        if (msg.sender != sealer && msg.sender != owner) revert Unauthorized();
        _;
    }

    /**
     * @notice Seals an immutable Merkle root of `ON THE WIRE` findings for `epochHour`.
     */
    function sealTape(
        uint64 epochHour,
        bytes32 merkleRoot,
        uint32 dispatchCount,
        uint32 wiredFindingCount
    ) external onlySealer {
        if (epochHour == 0 || merkleRoot == bytes32(0) || wiredFindingCount == 0) revert ZeroValue();
        if (_tapes[epochHour].sealedAt != 0) revert AlreadySealed(epochHour);

        uint64 ts = uint64(block.timestamp);
        _tapes[epochHour] = TapeSeal({
            merkleRoot: merkleRoot,
            sealedAt: ts,
            dispatchCount: dispatchCount,
            wiredFindingCount: wiredFindingCount
        });

        unchecked {
            totalTapesSealed += 1;
        }
        if (epochHour > latestEpoch) {
            latestEpoch = epochHour;
        }

        emit TapeSealed(epochHour, merkleRoot, dispatchCount, wiredFindingCount, ts);
    }

    /**
     * @notice Returns the immutable seal metadata for `epochHour`.
     */
    function getTapeSeal(uint64 epochHour)
        external
        view
        returns (
            bytes32 merkleRoot,
            uint64 sealedAt,
            uint32 dispatchCount,
            uint32 wiredFindingCount
        )
    {
        TapeSeal memory t = _tapes[epochHour];
        return (t.merkleRoot, t.sealedAt, t.dispatchCount, t.wiredFindingCount);
    }

    /**
     * @notice Verifies a sorted-pair Keccak-256 Merkle proof against the stored `epochHour` tape root.
     */
    function verifyFindingLeaf(
        uint64 epochHour,
        bytes32 leafHash,
        bytes32[] calldata proof
    ) external view returns (bool valid) {
        bytes32 root = _tapes[epochHour].merkleRoot;
        if (root == bytes32(0) || leafHash == bytes32(0)) return false;

        bytes32 computed = leafHash;
        uint256 len = proof.length;
        for (uint256 i = 0; i < len; ) {
            bytes32 sibling = proof[i];
            if (computed <= sibling) {
                computed = keccak256(abi.encodePacked(computed, sibling));
            } else {
                computed = keccak256(abi.encodePacked(sibling, computed));
            }
            unchecked {
                ++i;
            }
        }
        return computed == root;
    }

    /**
     * @notice One-time binding of the `$WIRECOPY` ERC-20 token address after launch on Pons.
     */
    function bindToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroValue();
        if (wireToken != address(0)) revert TokenAlreadyBound();
        wireToken = token;
        emit WireTokenBound(token);
    }

    function setSealer(address newSealer) external onlyOwner {
        if (newSealer == address(0)) revert ZeroValue();
        address prev = sealer;
        sealer = newSealer;
        emit SealerUpdated(prev, newSealer);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroValue();
        address prev = owner;
        owner = newOwner;
        emit OwnershipTransferred(prev, newOwner);
    }

    /**
     * @notice Read-only caller tier lookup: 0 = Public Reader, 1 = Press Pass (>=1M), 2 = Bureau Chief (>=5M).
     */
    function tierOf(address account) external view returns (uint8 tier, uint256 balance) {
        if (account == address(0) || wireToken == address(0)) {
            return (0, 0);
        }
        balance = IERC20BalanceRead(wireToken).balanceOf(account);
        if (balance >= BUREAU_CHIEF_MIN) return (2, balance);
        if (balance >= PRESS_PASS_MIN) return (1, balance);
        return (0, balance);
    }
}
