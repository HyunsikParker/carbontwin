// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CarbonTwin cross-registry claim registry
/// @notice Registries record issuances per listing and vintage. An auditor links listings that
///         describe the same physical asset. After a link, a second registry can no longer issue
///         credits for a vintage another registry already issued, and overlaps that already exist
///         are emitted as conflicts. Audit reports are anchored as Merkle roots.
contract CreditClaimRegistry {
    struct Issuance {
        bytes32 listing;
        bytes8 registry;
        uint16 vintage;
        uint64 amount;
        uint64 retired;
    }

    uint16 public constant FIRST_VINTAGE = 1996;
    uint16 public constant LAST_VINTAGE = 2040;

    address public owner;
    mapping(address => bytes8) public registryOf;
    mapping(address => bool) public isAuditor;
    /// listing key => asset key (zero means the listing is its own asset)
    mapping(bytes32 => bytes32) public assetOf;
    /// asset key => number of listings that point to it
    mapping(bytes32 => uint32) public members;
    /// asset key => vintage => registry that first issued it
    mapping(bytes32 => mapping(uint16 => bytes8)) public vintageIssuer;
    mapping(bytes32 => Issuance) public issuances;
    bytes32[] public reportRoots;

    event RegistryAdded(address indexed operator, bytes8 code);
    event AuditorSet(address indexed auditor, bool enabled);
    event IssuanceRecorded(bytes32 indexed id, bytes32 indexed asset, bytes8 registry, uint16 vintage, uint64 amount);
    event ListingsLinked(bytes32 indexed asset, bytes32 listingA, bytes32 listingB, uint16 confidenceBps, bytes32 evidenceHash);
    event ConflictDetected(bytes32 indexed asset, uint16 vintage, bytes8 firstIssuer, bytes8 secondIssuer);
    event Retired(bytes32 indexed id, uint64 amount, bytes32 beneficiaryHash);
    event ReportAnchored(uint256 indexed index, bytes32 root, string uri);

    error NotOwner();
    error NotRegistry();
    error NotAuditor();
    error BadVintage(uint16 vintage);
    error DoubleIssuance(bytes32 asset, uint16 vintage, bytes8 firstIssuer);
    error DuplicateIssuance(bytes32 id);
    error UnknownIssuance(bytes32 id);
    error NotIssuer(bytes32 id);
    error OverRetirement(bytes32 id, uint64 available, uint64 requested);
    error AlreadyLinked(bytes32 listing);
    error SameAsset();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRegistry() {
        if (registryOf[msg.sender] == bytes8(0)) revert NotRegistry();
        _;
    }

    modifier onlyAuditor() {
        if (!isAuditor[msg.sender]) revert NotAuditor();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function addRegistry(address operator, bytes8 code) external onlyOwner {
        registryOf[operator] = code;
        emit RegistryAdded(operator, code);
    }

    function setAuditor(address auditor, bool enabled) external onlyOwner {
        isAuditor[auditor] = enabled;
        emit AuditorSet(auditor, enabled);
    }

    function assetKey(bytes32 listing) public view returns (bytes32) {
        bytes32 a = assetOf[listing];
        return a == bytes32(0) ? listing : a;
    }

    /// @notice Record credits a registry issued for one listing and vintage.
    function recordIssuance(bytes32 listing, uint16 vintage, uint64 amount, bytes32 serialHash)
        external
        onlyRegistry
        returns (bytes32 id)
    {
        if (vintage < FIRST_VINTAGE || vintage > LAST_VINTAGE) revert BadVintage(vintage);
        bytes8 code = registryOf[msg.sender];
        bytes32 asset = assetKey(listing);
        bytes8 first = vintageIssuer[asset][vintage];
        if (first != bytes8(0) && first != code) revert DoubleIssuance(asset, vintage, first);
        if (first == bytes8(0)) vintageIssuer[asset][vintage] = code;

        id = keccak256(abi.encode(listing, code, vintage, serialHash));
        if (issuances[id].amount != 0) revert DuplicateIssuance(id);
        issuances[id] = Issuance(listing, code, vintage, amount, 0);
        emit IssuanceRecorded(id, asset, code, vintage, amount);
    }

    /// @notice Declare that listing B describes the same physical asset as listing A.
    ///         Vintages both assets already issued from different registries are reported
    ///         as conflicts; B's other vintages are merged into A's asset.
    function linkListings(bytes32 listingA, bytes32 listingB, uint16 confidenceBps, bytes32 evidenceHash)
        external
        onlyAuditor
        returns (uint256 conflicts)
    {
        if (assetOf[listingB] != bytes32(0) || members[listingB] != 0) revert AlreadyLinked(listingB);
        bytes32 asset = assetKey(listingA);
        if (asset == listingB) revert SameAsset();
        for (uint16 v = FIRST_VINTAGE; v <= LAST_VINTAGE; v++) {
            bytes8 b = vintageIssuer[listingB][v];
            if (b == bytes8(0)) continue;
            bytes8 a = vintageIssuer[asset][v];
            if (a == bytes8(0)) {
                vintageIssuer[asset][v] = b;
            } else if (a != b) {
                conflicts++;
                emit ConflictDetected(asset, v, a, b);
            }
        }
        assetOf[listingB] = asset;
        members[asset] += 1;
        emit ListingsLinked(asset, listingA, listingB, confidenceBps, evidenceHash);
    }

    function retire(bytes32 id, uint64 amount, bytes32 beneficiaryHash) external onlyRegistry {
        Issuance storage it = issuances[id];
        if (it.amount == 0) revert UnknownIssuance(id);
        if (it.registry != registryOf[msg.sender]) revert NotIssuer(id);
        uint64 available = it.amount - it.retired;
        if (amount > available) revert OverRetirement(id, available, amount);
        it.retired += amount;
        emit Retired(id, amount, beneficiaryHash);
    }

    function anchorReport(bytes32 root, string calldata uri) external onlyAuditor returns (uint256 index) {
        reportRoots.push(root);
        index = reportRoots.length - 1;
        emit ReportAnchored(index, root, uri);
    }

    function reportCount() external view returns (uint256) {
        return reportRoots.length;
    }

    /// @notice Verify that a finding leaf belongs to an anchored report (sorted-pair Merkle tree).
    function verifyFinding(uint256 index, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return index < reportRoots.length && h == reportRoots[index];
    }
}
